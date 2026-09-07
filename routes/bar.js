'use strict';

const express = require('express');
const config = require('../config');
const {
  resolveActor,
  sendActorError,
} = require('../middleware/resolveActor');

const {
  settleBarCheckPayment,
} = require('../lib/barCheckSettlement');
const {
  reconcileSucceededPayment,
} = require('./payments/payments.webhook');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STAFF_ROLES = new Set(['Manager', 'Employee']);
const CHECK_STATUSES = new Set(['OPEN', 'CLOSED', 'VOIDED']);

const REUSABLE_INTENT_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
]);

const STRIPE_STATUS_TO_DB = Object.freeze({
  requires_payment_method:
    'REQUIRES_PAYMENT_METHOD',
  requires_confirmation:
    'REQUIRES_CONFIRMATION',
  requires_action:
    'REQUIRES_CONFIRMATION',
  processing:
    'PROCESSING',
  succeeded:
    'SUCCEEDED',
  canceled:
    'CANCELLED',
});

function toPaymentStatusEnum(stripeStatus) {
  const normalized = String(
    stripeStatus || ''
  )
    .trim()
    .toLowerCase();

  const mappedStatus =
    STRIPE_STATUS_TO_DB[normalized];

  if (!mappedStatus) {
    throw new Error(
      'STRIPE_PAYMENT_STATUS_UNSUPPORTED'
    );
  }

  return mappedStatus;
}

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function requireStaff(actor) {
  if (!STAFF_ROLES.has(actor.role)) {
    const error = new Error('Staff access required.');
    error.status = 403;
    error.statusCode = 403;
    throw error;
  }
}

function normalizeDisplayName(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const normalized = String(value).trim();
  if (!normalized || normalized.length > 120) {
    const error = new Error('display_name must be between 1 and 120 characters.');
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function sendRequestError(req, res, error, eventName) {
  const statusCode =
    [400, 401, 403, 404, 409].includes(error?.statusCode)
      ? error.statusCode
      : [400, 401, 403, 404, 409].includes(error?.status)
        ? error.status
        : 500;

  if (statusCode === 401 || statusCode === 403) {
    return sendActorError(req, res, error);
  }

  req.logEvent?.(
    statusCode >= 500 ? 'error' : 'warn',
    eventName,
    {
      statusCode,
      reason: error?.message || 'unknown_error',
    }
  );

  if (statusCode >= 500) {
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(statusCode).json({ error: error.message });
}

module.exports = function barRoutes(pool, verifyToken) {
  const router = express.Router();

  router.get('/chairs', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const result = await pool.query(
        `SELECT
           id,
           chair_number,
           display_name,
           active,
           created_at,
           updated_at
         FROM bar_chairs
         WHERE restaurant_id = $1
         ORDER BY chair_number ASC`,
        [actor.restaurantId]
      );

      return res.json({ chairs: result.rows });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_chairs_list_failed');
    }
  });

  router.post('/chairs', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      if (actor.role !== 'Manager') {
        const error = new Error('Manager access required.');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }

      const chairNumber = Number(req.body?.chair_number);
      if (!Number.isInteger(chairNumber) || chairNumber <= 0) {
        const error = new Error('chair_number must be a positive integer.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);

      const result = await pool.query(
        `INSERT INTO bar_chairs (
           restaurant_id,
           chair_number,
           display_name
         )
         VALUES ($1, $2, $3)
         RETURNING
           id,
           chair_number,
           display_name,
           active,
           created_at,
           updated_at`,
        [actor.restaurantId, chairNumber, displayName ?? null]
      );

      return res.status(201).json({ chair: result.rows[0] });
    } catch (error) {
      if (error?.code === '23505') {
        error.status = 409;
        error.statusCode = 409;
        error.message = 'A bar chair with that number already exists.';
      }

      return sendRequestError(req, res, error, 'bar_chair_create_failed');
    }
  });

  router.patch('/chairs/:chairId', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      if (actor.role !== 'Manager') {
        const error = new Error('Manager access required.');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }

      const chairId = String(req.params.chairId || '').trim();
      if (!isUuid(chairId)) {
        const error = new Error('Invalid chair ID.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);
      const active =
        req.body?.active === undefined
          ? undefined
          : req.body.active;

      if (
        active !== undefined &&
        typeof active !== 'boolean'
      ) {
        const error = new Error('active must be a boolean.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      if (displayName === undefined && active === undefined) {
        const error = new Error('No supported chair fields were provided.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const result = await pool.query(
        `UPDATE bar_chairs
         SET
           display_name = COALESCE($3, display_name),
           active = COALESCE($4, active)
         WHERE id = $1
           AND restaurant_id = $2
         RETURNING
           id,
           chair_number,
           display_name,
           active,
           created_at,
           updated_at`,
        [
          chairId,
          actor.restaurantId,
          displayName === undefined ? null : displayName,
          active === undefined ? null : active,
        ]
      );

      if (result.rowCount !== 1) {
        const error = new Error('Bar chair not found.');
        error.status = 404;
        error.statusCode = 404;
        throw error;
      }

      return res.json({ chair: result.rows[0] });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_chair_update_failed');
    }
  });

  router.get('/checks', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const status =
        req.query?.status === undefined
          ? 'OPEN'
          : String(req.query.status).trim().toUpperCase();

      if (!CHECK_STATUSES.has(status)) {
        const error = new Error('Invalid check status.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const result = await pool.query(
        `SELECT
           c.id,
           c.bar_chair_id,
           bc.chair_number,
           bc.display_name AS chair_display_name,
           c.opened_by_user_id,
           c.closed_by_user_id,
           c.display_name,
           c.status,
           c.opened_at,
           c.closed_at,
           c.created_at,
           c.updated_at
         FROM checks c
         LEFT JOIN bar_chairs bc
           ON bc.id = c.bar_chair_id
          AND bc.restaurant_id = c.restaurant_id
         WHERE c.restaurant_id = $1
           AND c.status = $2
         ORDER BY c.opened_at ASC`,
        [actor.restaurantId, status]
      );

      return res.json({ checks: result.rows });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_checks_list_failed');
    }
  });

  router.post('/checks', verifyToken, async (req, res) => {
    let client;

    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const barChairId =
        req.body?.bar_chair_id === undefined ||
        req.body?.bar_chair_id === null
          ? null
          : String(req.body.bar_chair_id).trim();

      if (barChairId !== null && !isUuid(barChairId)) {
        const error = new Error('Invalid bar_chair_id.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);

      client = await pool.connect();
      await client.query('BEGIN');

      if (barChairId !== null) {
        const chair = await client.query(
          `SELECT id, active
           FROM bar_chairs
           WHERE id = $1
             AND restaurant_id = $2
           FOR UPDATE`,
          [barChairId, actor.restaurantId]
        );

        if (chair.rowCount !== 1) {
          const error = new Error('Bar chair not found.');
          error.status = 404;
          error.statusCode = 404;
          throw error;
        }

        if (chair.rows[0].active !== true) {
          const error = new Error('Bar chair is inactive.');
          error.status = 409;
          error.statusCode = 409;
          throw error;
        }
      }

      const result = await client.query(
        `INSERT INTO checks (
           restaurant_id,
           bar_chair_id,
           opened_by_user_id,
           display_name
         )
         VALUES ($1, $2, $3, $4)
         RETURNING
           id,
           bar_chair_id,
           opened_by_user_id,
           closed_by_user_id,
           display_name,
           status,
           opened_at,
           closed_at,
           created_at,
           updated_at`,
        [
          actor.restaurantId,
          barChairId,
          actor.userId,
          displayName ?? null,
        ]
      );

      await client.query('COMMIT');
      return res.status(201).json({ check: result.rows[0] });
    } catch (error) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }

      if (
        error?.code === '23505' &&
        error?.constraint === 'uq_checks_one_open_per_bar_chair'
      ) {
        error.status = 409;
        error.statusCode = 409;
        error.message = 'That bar chair already has an open check.';
      }

      return sendRequestError(req, res, error, 'bar_check_create_failed');
    } finally {
      client?.release();
    }
  });

  router.get('/checks/:checkId', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const checkId = String(req.params.checkId || '').trim();
      if (!isUuid(checkId)) {
        const error = new Error('Invalid check ID.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const result = await pool.query(
        `SELECT
           c.id,
           c.bar_chair_id,
           bc.chair_number,
           bc.display_name AS chair_display_name,
           c.opened_by_user_id,
           c.closed_by_user_id,
           c.display_name,
           c.status,
           c.opened_at,
           c.closed_at,
           c.created_at,
           c.updated_at
         FROM checks c
         LEFT JOIN bar_chairs bc
           ON bc.id = c.bar_chair_id
          AND bc.restaurant_id = c.restaurant_id
         WHERE c.id = $1
           AND c.restaurant_id = $2
         LIMIT 1`,
        [checkId, actor.restaurantId]
      );

      if (result.rowCount !== 1) {
        const error = new Error('Check not found.');
        error.status = 404;
        error.statusCode = 404;
        throw error;
      }

      return res.json({ check: result.rows[0] });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_check_read_failed');
    }
  });

  router.post(
    '/checks/:checkId/payment-intent',
    verifyToken,
    async (req, res) => {
      const client = await pool.connect();

      try {
        const actor = await resolveActor(
          pool,
          req
        );
        requireStaff(actor);

        const checkId = String(
          req.params.checkId || ''
        ).trim();

        if (!isUuid(checkId)) {
          const error = new Error(
            'Invalid check id.'
          );
          error.status = 400;
          error.statusCode = 400;
          throw error;
        }

        const stripeKey = String(
          config.stripe.secretKey || ''
        ).trim();

        if (!stripeKey) {
          const error = new Error(
            'Payments unavailable'
          );
          error.status = 503;
          error.statusCode = 503;
          throw error;
        }

        const idempotencyKey = String(
          req.get('Idempotency-Key') ||
          req.get('idempotency-key') ||
          ''
        ).trim();

        if (!idempotencyKey) {
          const error = new Error(
            'Missing Idempotency-Key header'
          );
          error.status = 400;
          error.statusCode = 400;
          throw error;
        }

        const stripe =
          require('stripe')(stripeKey);

        await client.query('BEGIN');

        const checkResult =
          await client.query(
            `SELECT
               id,
               restaurant_id,
               status,
               check_type
             FROM checks
             WHERE id = $1
               AND restaurant_id = $2
               AND check_type = 'BAR'
             FOR UPDATE`,
            [
              checkId,
              actor.restaurantId,
            ]
          );

        if (checkResult.rowCount === 0) {
          const error = new Error(
            'Bar check not found.'
          );
          error.status = 404;
          error.statusCode = 404;
          throw error;
        }

        const check = checkResult.rows[0];

        if (check.status !== 'OPEN') {
          const error = new Error(
            'Bar check is not open.'
          );
          error.status = 409;
          error.statusCode = 409;
          throw error;
        }

        const ordersResult =
          await client.query(
            `SELECT
               id,
               total_cents,
               paid_cents,
               comped_cents,
               status
             FROM orders
             WHERE check_id = $1
               AND restaurant_id = $2
               AND status <> 'CANCELLED'
             ORDER BY opened_at ASC, id ASC
             FOR UPDATE`,
            [
              checkId,
              actor.restaurantId,
            ]
          );

        const amountOwedCents =
          ordersResult.rows.reduce(
            (sum, order) => {
              const totalCents =
                Number(order.total_cents || 0);
              const paidCents =
                Number(order.paid_cents || 0);
              const compedCents =
                Number(order.comped_cents || 0);

              return (
                sum +
                Math.max(
                  0,
                  totalCents -
                    paidCents -
                    compedCents
                )
              );
            },
            0
          );

        if (
          !Number.isInteger(amountOwedCents) ||
          amountOwedCents <= 0
        ) {
          const error = new Error(
            'Bar check already paid.'
          );
          error.status = 409;
          error.statusCode = 409;
          throw error;
        }

        const latestPayment =
          await client.query(
            `SELECT
               id,
               order_id,
               check_id,
               restaurant_id,
               amount_cents,
               payment_intent_id,
               stripe_payment_intent_id,
               status
             FROM payments
             WHERE check_id = $1
               AND restaurant_id = $2
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [
              checkId,
              actor.restaurantId,
            ]
          );

        const persisted =
          latestPayment.rows[0] || null;

        if (
          persisted?.payment_intent_id
        ) {
          const existing =
            await stripe.paymentIntents.retrieve(
              persisted.payment_intent_id
            );

          const existingStatus =
            String(existing?.status || '')
              .trim()
              .toLowerCase();

          const amountMatches =
            Number.isInteger(existing?.amount) &&
            existing.amount ===
              amountOwedCents;

          const currencyMatches =
            String(existing?.currency || '')
              .trim()
              .toLowerCase() === 'usd';

          const metadataMatches =
            String(
              existing?.metadata
                ?.payment_scope || ''
            ) === 'BAR_CHECK' &&
            String(
              existing?.metadata?.check_id ||
                ''
            ) === String(checkId) &&
            String(
              existing?.metadata
                ?.restaurant_id || ''
            ) ===
              String(actor.restaurantId);

          const persistedIdentityMatches =
            persisted.order_id === null &&
            String(
              persisted.check_id || ''
            ) === String(checkId) &&
            String(
              persisted.restaurant_id || ''
            ) ===
              String(actor.restaurantId) &&
            String(
              persisted.payment_intent_id ||
                ''
            ) === String(existing?.id || '');

          const persistedAmountMatches =
            Number(
              persisted.amount_cents
            ) === amountOwedCents;

          if (
            REUSABLE_INTENT_STATUSES.has(
              existingStatus
            ) &&
            amountMatches &&
            currencyMatches &&
            metadataMatches &&
            persistedIdentityMatches &&
            persistedAmountMatches
          ) {
            await client.query('COMMIT');

            return res.status(200).json({
              paymentIntentId:
                existing.id,
              paymentIntentClientSecret:
                existing.client_secret,
              amountCents:
                amountOwedCents,
              reused: true,
            });
          }

          if (
            existingStatus === 'succeeded' &&
            Number.isInteger(
              existing?.amount
            ) &&
            Number(existing.amount) ===
              Number(
                persisted.amount_cents
              ) &&
            currencyMatches &&
            metadataMatches &&
            persistedIdentityMatches
          ) {
            const reconciliation =
              await reconcileSucceededPayment(
                client,
                existing.id,
                existing.amount
              );

            await client.query('COMMIT');

            return res.status(200).json({
              paymentIntentId:
                existing.id,
              amountCents:
                existing.amount,
              paymentCompleted: true,
              reconciled:
                !reconciliation.deduplicated,
              reused: false,
            });
          }

          const error = new Error(
            'PAYMENT_INTENT_REUSE_INCOMPATIBLE'
          );
          error.status = 409;
          error.statusCode = 409;
          throw error;
        }

        const paymentIntent =
          await stripe.paymentIntents.create(
            {
              amount: amountOwedCents,
              currency: 'usd',
              automatic_payment_methods: {
                enabled: true,
              },
              metadata: {
                payment_scope:
                  'BAR_CHECK',
                check_id:
                  String(checkId),
                restaurant_id:
                  String(
                    actor.restaurantId
                  ),
              },
            },
            {
              idempotencyKey,
            }
          );

        const statusEnum =
          toPaymentStatusEnum(
            paymentIntent.status
          );

        const persistedAmountCents =
          Number.isInteger(
            paymentIntent.amount
          )
            ? paymentIntent.amount
            : amountOwedCents;

        await client.query(
          `INSERT INTO payments (
             order_id,
             check_id,
             restaurant_id,
             payment_intent_id,
             stripe_payment_intent_id,
             status,
             amount_cents
           )
           VALUES (
             NULL,
             $1,
             $2,
             $3,
             $4,
             $5,
             $6
           )
           ON CONFLICT (
             payment_intent_id
           )
           DO UPDATE SET
             order_id = NULL,
             check_id =
               EXCLUDED.check_id,
             restaurant_id =
               EXCLUDED.restaurant_id,
             stripe_payment_intent_id =
               EXCLUDED.stripe_payment_intent_id,
             status =
               EXCLUDED.status,
             amount_cents =
               EXCLUDED.amount_cents`,
          [
            checkId,
            actor.restaurantId,
            paymentIntent.id,
            paymentIntent.id,
            statusEnum,
            persistedAmountCents,
          ]
        );

        await client.query('COMMIT');

        return res.status(200).json({
          paymentIntentId:
            paymentIntent.id,
          paymentIntentClientSecret:
            paymentIntent.client_secret,
          amountCents:
            amountOwedCents,
          reused: false,
        });
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (_rollbackError) {}

        return sendRequestError(
          req,
          res,
          error,
          'bar_check_payment_intent_failed'
        );
      } finally {
        client.release();
      }
    }
  );

  router.post('/checks/:checkId/pay', verifyToken, async (req, res) => {
    const client = await pool.connect();

    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const checkId = String(req.params.checkId || '').trim();
      const paymentMethod = String(
        req.body?.payment_method || ''
      ).trim().toLowerCase();

      if (!isUuid(checkId)) {
        const error = new Error('Invalid check id.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      if (!['cash', 'card'].includes(paymentMethod)) {
        const error = new Error(
          'payment_method must be cash or card.'
        );
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      await client.query('BEGIN');

      const settlement = await settleBarCheckPayment({
        client,
        restaurantId: actor.restaurantId,
        checkId,
        paymentMethod,
        actor,
      });

      await client.query('COMMIT');

      return res.status(200).json({
        check_id: checkId,
        payment_method: paymentMethod,
        ...settlement,
      });
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {}

      return sendRequestError(
        req,
        res,
        error,
        'bar_check_pay_failed'
      );
    } finally {
      client.release();
    }
  });

  router.patch('/checks/:checkId', verifyToken, async (req, res) => {
    let client;

    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const checkId = String(req.params.checkId || '').trim();
      if (!isUuid(checkId)) {
        const error = new Error('Invalid check ID.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);
      const barChairId =
        req.body?.bar_chair_id === undefined
          ? undefined
          : req.body.bar_chair_id === null
            ? null
            : String(req.body.bar_chair_id).trim();

      if (
        barChairId !== undefined &&
        barChairId !== null &&
        !isUuid(barChairId)
      ) {
        const error = new Error('Invalid bar_chair_id.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      if (displayName === undefined && barChairId === undefined) {
        const error = new Error('No supported check fields were provided.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      client = await pool.connect();
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id, status
         FROM checks
         WHERE id = $1
           AND restaurant_id = $2
         FOR UPDATE`,
        [checkId, actor.restaurantId]
      );

      if (existing.rowCount !== 1) {
        const error = new Error('Check not found.');
        error.status = 404;
        error.statusCode = 404;
        throw error;
      }

      if (existing.rows[0].status !== 'OPEN') {
        const error = new Error('Only open checks can be updated.');
        error.status = 409;
        error.statusCode = 409;
        throw error;
      }

      if (barChairId !== undefined && barChairId !== null) {
        const chair = await client.query(
          `SELECT id, active
           FROM bar_chairs
           WHERE id = $1
             AND restaurant_id = $2
           FOR UPDATE`,
          [barChairId, actor.restaurantId]
        );

        if (chair.rowCount !== 1) {
          const error = new Error('Bar chair not found.');
          error.status = 404;
          error.statusCode = 404;
          throw error;
        }

        if (chair.rows[0].active !== true) {
          const error = new Error('Bar chair is inactive.');
          error.status = 409;
          error.statusCode = 409;
          throw error;
        }
      }

      const result = await client.query(
        `UPDATE checks
         SET
           display_name = CASE
             WHEN $3::boolean THEN $4
             ELSE display_name
           END,
           bar_chair_id = CASE
             WHEN $5::boolean THEN $6
             ELSE bar_chair_id
           END
         WHERE id = $1
           AND restaurant_id = $2
         RETURNING
           id,
           bar_chair_id,
           opened_by_user_id,
           closed_by_user_id,
           display_name,
           status,
           opened_at,
           closed_at,
           created_at,
           updated_at`,
        [
          checkId,
          actor.restaurantId,
          displayName !== undefined,
          displayName ?? null,
          barChairId !== undefined,
          barChairId ?? null,
        ]
      );

      await client.query('COMMIT');
      return res.json({ check: result.rows[0] });
    } catch (error) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }

      if (
        error?.code === '23505' &&
        error?.constraint === 'uq_checks_one_open_per_bar_chair'
      ) {
        error.status = 409;
        error.statusCode = 409;
        error.message = 'That bar chair already has an open check.';
      }

      return sendRequestError(req, res, error, 'bar_check_update_failed');
    } finally {
      client?.release();
    }
  });

  return router;
};
