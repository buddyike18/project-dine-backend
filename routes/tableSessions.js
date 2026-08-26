const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const {
  resolveActor,
  sendActorError,
} = require('../middleware/resolveActor');

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DATABASE_UNAVAILABLE_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);

function isValidSessionToken(value) {
  return (
    typeof value === 'string' &&
    value.length >= MIN_TOKEN_LENGTH &&
    value.length <= MAX_TOKEN_LENGTH &&
    TOKEN_PATTERN.test(value)
  );
}

function isValidTableId(value) {
  return (
    typeof value === 'string' &&
    TABLE_ID_PATTERN.test(value)
  );
}

function isValidTableUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isValidTableSignature(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{64}$/i.test(value)
  );
}

function signTableLink(tableUuid, signingSecret) {
  return crypto
    .createHmac('sha256', signingSecret)
    .update(tableUuid, 'utf8')
    .digest('hex');
}

function verifyTableLinkSignature(
  tableUuid,
  suppliedSignature,
  signingSecret
) {
  if (
    !isValidTableUuid(tableUuid) ||
    !isValidTableSignature(suppliedSignature) ||
    typeof signingSecret !== 'string' ||
    signingSecret.length === 0
  ) {
    return false;
  }

  const expected = Buffer.from(
    signTableLink(tableUuid, signingSecret),
    'hex'
  );

  const supplied = Buffer.from(
    suppliedSignature,
    'hex'
  );

  return (
    expected.length === supplied.length &&
    crypto.timingSafeEqual(expected, supplied)
  );
}

function isManagerActor(req) {
  return req.actor?.role === 'Manager';
}

function hashSessionToken(value) {
  return crypto
    .createHash('sha256')
    .update(value, 'utf8')
    .digest();
}

function isDatabaseUnavailable(error) {
  const code = String(error?.code || '').trim();

  if (DATABASE_UNAVAILABLE_CODES.has(code)) {
    return true;
  }

  const nestedCode = String(
    error?.cause?.code || '',
  ).trim();

  return DATABASE_UNAVAILABLE_CODES.has(nestedCode);
}


const RATE_LIMIT_WINDOW_SECONDS = 60;
const NETWORK_RATE_LIMIT_MAX_REQUESTS = 300;
const TOKEN_RATE_LIMIT_MAX_REQUESTS = 10;

function getRateLimitClientKey(req) {
  const normalizedClientIdentifier = String(
    req.ip || ''
  ).trim();

  if (!normalizedClientIdentifier) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(normalizedClientIdentifier, 'utf8')
    .digest();
}

async function consumeVerificationAttempt(
  pool,
  limitType,
  clientKey,
  maxRequests
) {
  const result = await pool.query(
    `INSERT INTO public.table_session_verification_limits (
       limit_type,
       client_key,
       window_started_at,
       attempt_count,
       updated_at
     )
     VALUES (
       $1,
       $2,
       date_trunc('second', now()),
       1,
       now()
     )
     ON CONFLICT (limit_type, client_key)
     DO UPDATE SET
       window_started_at = CASE
         WHEN
           public.table_session_verification_limits.window_started_at
             <= now() - make_interval(secs => $3)
         THEN date_trunc('second', now())
         ELSE
           public.table_session_verification_limits.window_started_at
       END,
       attempt_count = CASE
         WHEN
           public.table_session_verification_limits.window_started_at
             <= now() - make_interval(secs => $3)
         THEN 1
         ELSE
           public.table_session_verification_limits.attempt_count
             + 1
       END,
       updated_at = now()
     RETURNING attempt_count`,
    [
      limitType,
      clientKey,
      RATE_LIMIT_WINDOW_SECONDS,
    ]
  );

  if (result.rows.length !== 1) {
    throw new Error(
      'TABLE_SESSION_RATE_LIMIT_STATE_INVALID'
    );
  }

  return (
    Number(result.rows[0].attempt_count) <=
    maxRequests
  );
}

module.exports = (pool, verifyToken) => {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError(
      'tableSessions router requires a PostgreSQL pool'
    );
  }

  if (typeof verifyToken !== 'function') {
    throw new TypeError(
      'tableSessions router requires verifyToken middleware'
    );
  }

  const router = express.Router();

  const resolveActorMiddleware = async (req, res, next) => {
    try {
      req.actor = await resolveActor(pool, req);
      return next();
    } catch (error) {
      return sendActorError(req, res, error);
    }
  };

  router.post(
    '/issue',
    verifyToken,
    resolveActorMiddleware,
    async (req, res) => {
      if (!isManagerActor(req)) {
        return res.status(403).json({
          error: 'Forbidden.',
        });
      }

      const restaurantId = String(
        req.actor?.restaurantId || ''
      ).trim();

      const actorUserId = String(
        req.actor?.userId || ''
      ).trim();

      const tableId = String(
        req.body?.tableId || ''
      ).trim();

      if (
        !restaurantId ||
        !actorUserId ||
        !isValidTableId(tableId)
      ) {
        return res.status(400).json({
          error: 'Invalid table session request.',
        });
      }

      const baseUrl =
        config.links?.tableSessionBaseUrl;

      if (!baseUrl) {
        req.logEvent?.(
          'error',
          'table_session_issue_failed',
          {
            reason:
              'link_configuration_unavailable',
            statusCode: 503,
          }
        );

        return res.status(503).json({
          error: 'Service unavailable.',
        });
      }

      const rawToken = crypto
        .randomBytes(32)
        .toString('base64url');

      const tokenHash =
        hashSessionToken(rawToken);

      let client;
      let issuanceCommitted = false;

      try {
        client = await pool.connect();
        await client.query('BEGIN');

        const tableResult =
          await client.query(
            `SELECT rt.id
             FROM public.restaurant_tables rt
             INNER JOIN public.restaurants r
               ON r.id = rt.restaurant_id
             WHERE rt.restaurant_id = $1
               AND rt.table_id = $2
               AND rt.active = TRUE
               AND r.active = TRUE
             FOR UPDATE OF rt`,
            [restaurantId, tableId]
          );

        if (tableResult.rows.length !== 1) {
          await client.query('ROLLBACK');

          return res.status(404).json({
            error: 'Table not found.',
          });
        }

        await client.query(
          `UPDATE public.table_sessions
           SET
             status = 'REVOKED',
             revoked_at = now()
           WHERE restaurant_id = $1
             AND table_id = $2
             AND status = 'ACTIVE'
             AND revoked_at IS NULL`,
          [restaurantId, tableId]
        );

        await client.query(
          `INSERT INTO public.table_sessions (
             restaurant_id,
             table_id,
             token_hash,
             status,
             created_by_user_id
           )
           VALUES ($1, $2, $3, 'ACTIVE', $4)`,
          [
            restaurantId,
            tableId,
            tokenHash,
            actorUserId,
          ]
        );

        await client.query('COMMIT');
        issuanceCommitted = true;
      } catch (error) {
        if (client && !issuanceCommitted) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve original failure classification.
          }
        }

        const databaseUnavailable =
          isDatabaseUnavailable(error);

        req.logEvent?.(
          'error',
          'table_session_issue_failed',
          {
            reason: databaseUnavailable
              ? 'database_unavailable'
              : 'issuance_internal_error',
            statusCode: databaseUnavailable
              ? 503
              : 500,
          }
        );

        return res
          .status(
            databaseUnavailable ? 503 : 500
          )
          .json({
            error: databaseUnavailable
              ? 'Service unavailable.'
              : 'Unable to issue table session.',
          });
      } finally {
        client?.release();
      }

      const qrUrl =
        `${baseUrl}/scan?sessionToken=${encodeURIComponent(
          rawToken
        )}`;

      try {
        req.logEvent?.(
          'info',
          'table_session_issued',
          {
            reason:
              'active_session_rotated',
            statusCode: 201,
          }
        );
      } catch {
        // Logging must not change a committed issuance result.
      }

      return res.status(201).json({
        sessionToken: rawToken,
        qrUrl,
      });
    }
  );

  router.post(
    '/revoke',
    verifyToken,
    resolveActorMiddleware,
    async (req, res) => {
      if (!isManagerActor(req)) {
        return res.status(403).json({
          error: 'Forbidden.',
        });
      }

      const restaurantId = String(
        req.actor?.restaurantId || ''
      ).trim();

      const tableId = String(
        req.body?.tableId || ''
      ).trim();

      if (
        !restaurantId ||
        !isValidTableId(tableId)
      ) {
        return res.status(400).json({
          error: 'Invalid table session request.',
        });
      }

      let client;
      let revocationCommitted = false;

      try {
        client = await pool.connect();
        await client.query('BEGIN');

        const tableResult =
          await client.query(
            `SELECT rt.id
             FROM public.restaurant_tables rt
             INNER JOIN public.restaurants r
               ON r.id = rt.restaurant_id
             WHERE rt.restaurant_id = $1
               AND rt.table_id = $2
               AND r.active = TRUE
             FOR UPDATE OF rt`,
            [restaurantId, tableId]
          );

        if (tableResult.rows.length !== 1) {
          await client.query('ROLLBACK');

          return res.status(404).json({
            error: 'Table not found.',
          });
        }

        await client.query(
          `UPDATE public.table_sessions
           SET
             status = 'REVOKED',
             revoked_at = now()
           WHERE restaurant_id = $1
             AND table_id = $2
             AND status = 'ACTIVE'
             AND revoked_at IS NULL`,
          [restaurantId, tableId]
        );

        await client.query('COMMIT');
        revocationCommitted = true;
      } catch (error) {
        if (client && !revocationCommitted) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve original failure classification.
          }
        }

        return sendActorError(
          req,
          res,
          error
        );
      } finally {
        client?.release();
      }

      try {
        req.logEvent?.(
          'info',
          'table_session_revoked',
          {
            reason: 'revocation_completed',
            statusCode: 200,
          }
        );
      } catch {
        // Logging must not change a committed revocation result.
      }

      return res.status(200).json({
        success: true,
      });
    }
  );

  router.post(
    '/verify-table-link',
    async (req, res) => {
      const tableUuid = String(
        req.body?.table || ''
      ).trim();

      const signature = String(
        req.body?.sig || ''
      ).trim();

      const clientKey = getRateLimitClientKey(req);

      try {
        if (!clientKey) {
          return res.status(400).json({
            error: 'Unable to verify table link',
          });
        }

        const networkAllowed =
          await consumeVerificationAttempt(
            pool,
            'network',
            clientKey,
            NETWORK_RATE_LIMIT_MAX_REQUESTS
          );

        if (!networkAllowed) {
          return res.status(429).json({
            error: 'Too many verification attempts',
          });
        }

        if (
          !isValidTableUuid(tableUuid) ||
          !isValidTableSignature(signature)
        ) {
          return res.status(400).json({
            error: 'Invalid table link',
          });
        }

        const signingSecret =
          config.links?.tableLinkSigningSecret;

        if (
          typeof signingSecret !== 'string' ||
          signingSecret.length === 0
        ) {
          return res.status(503).json({
            error: 'Table link verification unavailable',
          });
        }

        const credentialKey = crypto
          .createHash('sha256')
          .update(
            `${tableUuid}:${signature}`,
            'utf8'
          )
          .digest();

        const credentialAllowed =
          await consumeVerificationAttempt(
            pool,
            'token',
            credentialKey,
            TOKEN_RATE_LIMIT_MAX_REQUESTS
          );

        if (!credentialAllowed) {
          return res.status(429).json({
            error: 'Too many verification attempts',
          });
        }

        const signatureValid =
          verifyTableLinkSignature(
            tableUuid,
            signature,
            signingSecret
          );

        if (!signatureValid) {
          return res.status(400).json({
            error: 'Invalid table link',
          });
        }

        const result = await pool.query(
          `SELECT
             rt.restaurant_id,
             rt.table_id
           FROM restaurant_tables rt
           JOIN restaurants r
             ON r.id = rt.restaurant_id
           WHERE rt.id = $1
             AND rt.active = TRUE
             AND r.active = TRUE
           LIMIT 1`,
          [tableUuid]
        );

        if (result.rowCount !== 1) {
          return res.status(404).json({
            error: 'Table not available',
          });
        }

        return res.status(200).json({
          session: {
            restaurantId:
              result.rows[0].restaurant_id,
            table:
              result.rows[0].table_id,
          },
        });
      } catch (error) {
        const databaseUnavailable =
          isDatabaseUnavailable(error);

        console.error(
          '[TABLE_SESSION_TABLE_LINK_VERIFY_FAILED]',
          {
            error:
              databaseUnavailable
                ? 'DATABASE_UNAVAILABLE'
                : 'INTERNAL_ERROR',
          }
        );

        return res
          .status(
            databaseUnavailable
              ? 503
              : 500
          )
          .json({
            error:
              databaseUnavailable
                ? 'Table link verification unavailable'
                : 'Unable to verify table link',
          });
      }
    }
  );

  router.post('/verify', async (req, res) => {
    const networkClientKey =
      getRateLimitClientKey(req);

    if (!networkClientKey) {
      req.logEvent?.(
        'error',
        'table_session_verification_failed',
        {
          reason: 'client_identity_unavailable',
          statusCode: 503,
        }
      );

      return res.status(503).json({
        error: 'Service unavailable.',
      });
    }

    try {
      const networkAllowed =
        await consumeVerificationAttempt(
          pool,
          'network',
          networkClientKey,
          NETWORK_RATE_LIMIT_MAX_REQUESTS
        );

      if (!networkAllowed) {
        req.logEvent?.(
          'warn',
          'table_session_verification_failed',
          {
            reason: 'rate_limit_exceeded',
            statusCode: 429,
          }
        );

        return res.status(429).json({
          error:
            'Too many verification attempts.',
        });
      }
    } catch (error) {
      const databaseUnavailable =
        isDatabaseUnavailable(error);

      req.logEvent?.(
        'error',
        'table_session_verification_failed',
        {
          reason: databaseUnavailable
            ? 'rate_limit_database_unavailable'
            : 'rate_limit_internal_error',
          statusCode: databaseUnavailable
            ? 503
            : 500,
        }
      );

      return res
        .status(databaseUnavailable ? 503 : 500)
        .json({
          error: databaseUnavailable
            ? 'Service unavailable.'
            : 'Unable to verify table session.',
        });
    }

    const sessionToken =
      typeof req.body?.sessionToken === 'string'
        ? req.body.sessionToken.trim()
        : '';

    if (!isValidSessionToken(sessionToken)) {
      req.logEvent?.(
        'warn',
        'table_session_verification_failed',
        {
          reason: 'invalid_token_format',
          statusCode: 400,
        }
      );

      return res.status(400).json({
        error: 'Invalid table session.',
      });
    }

    const tokenHash =
      hashSessionToken(sessionToken);

    try {
      const tokenAllowed =
        await consumeVerificationAttempt(
          pool,
          'token',
          tokenHash,
          TOKEN_RATE_LIMIT_MAX_REQUESTS
        );

      if (!tokenAllowed) {
        req.logEvent?.(
          'warn',
          'table_session_verification_failed',
          {
            reason: 'rate_limit_exceeded',
            statusCode: 429,
          }
        );

        return res.status(429).json({
          error:
            'Too many verification attempts.',
        });
      }
    } catch (error) {
      const databaseUnavailable =
        isDatabaseUnavailable(error);

      req.logEvent?.(
        'error',
        'table_session_verification_failed',
        {
          reason: databaseUnavailable
            ? 'rate_limit_database_unavailable'
            : 'rate_limit_internal_error',
          statusCode: databaseUnavailable
            ? 503
            : 500,
        }
      );

      return res
        .status(databaseUnavailable ? 503 : 500)
        .json({
          error: databaseUnavailable
            ? 'Service unavailable.'
            : 'Unable to verify table session.',
        });
    }

    try {
      const result = await pool.query(
        `SELECT
           ts.restaurant_id,
           ts.table_id
         FROM public.table_sessions ts
         INNER JOIN public.restaurants r
           ON r.id = ts.restaurant_id
         INNER JOIN public.restaurant_tables rt
           ON rt.restaurant_id = ts.restaurant_id
          AND rt.table_id = ts.table_id
         WHERE ts.token_hash = $1
           AND ts.status = 'ACTIVE'
           AND ts.revoked_at IS NULL
           AND (
             ts.expires_at IS NULL
             OR ts.expires_at > now()
           )
           AND r.active = TRUE
           AND rt.active = TRUE
         LIMIT 1`,
        [tokenHash]
      );

      if (result.rows.length !== 1) {
        req.logEvent?.(
          'warn',
          'table_session_verification_failed',
          {
            reason: 'invalid_expired_or_revoked',
            statusCode: 404,
          }
        );

        return res.status(404).json({
          error: 'Table session not found.',
        });
      }

      const session = result.rows[0];

      req.logEvent?.(
        'info',
        'table_session_verification_succeeded',
        {
          reason: 'active_session_verified',
          statusCode: 200,
        }
      );

      return res.status(200).json({
        session: {
          restaurantId: session.restaurant_id,
          table: session.table_id,
        },
      });
    } catch (error) {
      const databaseUnavailable =
        isDatabaseUnavailable(error);

      req.logEvent?.(
        'error',
        'table_session_verification_failed',
        {
          reason: databaseUnavailable
            ? 'database_unavailable'
            : 'verification_internal_error',
          statusCode: databaseUnavailable
            ? 503
            : 500,
        }
      );

      if (databaseUnavailable) {
        return res.status(503).json({
          error: 'Service unavailable.',
        });
      }

      return res.status(500).json({
        error: 'Unable to verify table session.',
      });
    }
  });

  return router;
};
