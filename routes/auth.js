// routes/auth.js
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const {
  resolveActor: resolveActorFromDatabase,
  sendActorError,
} = require('../middleware/resolveActor');
const router = express.Router();

const FIREBASE_DELETION_CLAIM_LEASE_MS = 5 * 60 * 1000;

let processLogEvent = null;

const emitProcessEvent = (level, event, reason) => {
  processLogEvent?.(level, {
    at: 'firebase-deletion',
    event,
    requestId: null,
    reason,
  });
};

const handleError = (
  req,
  res,
  reason = 'auth_route_internal_error'
) => {
  req.logEvent?.(
    'error',
    'auth_route_failed',
    {
      reason,
    }
  );

  return res.status(500).json({
    error: 'Internal server error',
  });
};

const classifyFirebaseDeletionError = (err) => {
  if (err?.code === 'auth/user-not-found') {
    return 'firebase_user_not_found';
  }

  if (err?.code === 'auth/invalid-uid') {
    return 'firebase_invalid_uid';
  }

  if (err?.code === 'auth/insufficient-permission') {
    return 'firebase_insufficient_permission';
  }

  if (err?.code === 'auth/internal-error') {
    return 'firebase_internal_error';
  }

  return 'firebase_deletion_failed';
};

const markFirebaseDeletionCompleted = async (
  queryable,
  userId,
  firebaseUid,
  claimToken
) => {
  const result = await queryable.query(
    `UPDATE users
     SET firebase_deletion_status = 'COMPLETED',
         firebase_deletion_completed_at = COALESCE(
           firebase_deletion_completed_at,
           NOW()
         ),
         firebase_deletion_last_error = NULL,
         firebase_deletion_claimed_at = NULL,
         firebase_deletion_claim_token = NULL
     WHERE id = $1
       AND firebase_uid = $2
       AND active = false
       AND firebase_deletion_status = 'IN_PROGRESS'
       AND firebase_deletion_claim_token = $3
     RETURNING
       id,
       firebase_deletion_status,
       firebase_deletion_requested_at,
       firebase_deletion_completed_at`,
    [userId, firebaseUid, claimToken]
  );

  if (result.rowCount === 1) {
    return result.rows[0];
  }

  const completedResult = await queryable.query(
    `SELECT
       id,
       firebase_deletion_status,
       firebase_deletion_requested_at,
       firebase_deletion_completed_at
     FROM users
     WHERE id = $1
       AND firebase_uid = $2
       AND active = false
       AND firebase_deletion_status = 'COMPLETED'`,
    [userId, firebaseUid]
  );

  if (completedResult.rowCount === 1) {
    return completedResult.rows[0];
  }

  throw new Error(
    'Firebase deletion completion state update failed'
  );
};

const markFirebaseDeletionFailed = async (
  queryable,
  userId,
  firebaseUid,
  claimToken,
  err
) => {
  const result = await queryable.query(
    `UPDATE users
     SET firebase_deletion_status = 'FAILED',
         firebase_deletion_completed_at = NULL,
         firebase_deletion_last_error = $4,
         firebase_deletion_claimed_at = NULL,
         firebase_deletion_claim_token = NULL
     WHERE id = $1
       AND firebase_uid = $2
       AND active = false
       AND firebase_deletion_status = 'IN_PROGRESS'
       AND firebase_deletion_claim_token = $3
     RETURNING
       id,
       firebase_deletion_status,
       firebase_deletion_requested_at,
       firebase_deletion_last_error`,
    [
      userId,
      firebaseUid,
      claimToken,
      classifyFirebaseDeletionError(err),
    ]
  );

  if (result.rowCount !== 1) {
    throw new Error(
      'Firebase deletion failure state update failed'
    );
  }

  return result.rows[0];
};

const attemptFirebaseDeletion = async (
  queryable,
  userId,
  firebaseUid,
  claimToken
) => {
  try {
    await admin.auth().deleteUser(firebaseUid);

    return await markFirebaseDeletionCompleted(
      queryable,
      userId,
      firebaseUid,
      claimToken
    );
  } catch (err) {
    if (err?.code === 'auth/user-not-found') {
      return markFirebaseDeletionCompleted(
        queryable,
        userId,
        firebaseUid,
        claimToken
      );
    }

    const deletionState = await markFirebaseDeletionFailed(
      queryable,
      userId,
      firebaseUid,
      claimToken,
      err
    );

    const retryError = new Error(
      'Firebase account deletion failed'
    );

    retryError.cause = err;
    retryError.deletionState = deletionState;

    throw retryError;
  }
};

const processFirebaseDeletionRetry = async (pool) => {
  let claimedUser = null;

  {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const selectionResult = await client.query(
        `SELECT id, firebase_uid
         FROM users
         WHERE active = false
           AND (
             firebase_deletion_status IN ('PENDING', 'FAILED')
             OR (
               firebase_deletion_status = 'IN_PROGRESS'
               AND firebase_deletion_claimed_at
                 < NOW() - ($1 * INTERVAL '1 millisecond')
             )
           )
         ORDER BY
           CASE
             WHEN firebase_deletion_status = 'IN_PROGRESS'
               THEN firebase_deletion_claimed_at
             ELSE firebase_deletion_requested_at
           END ASC,
           id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [FIREBASE_DELETION_CLAIM_LEASE_MS]
      );

      if (selectionResult.rowCount === 0) {
        await client.query('COMMIT');
        return false;
      }

      const selectedUser = selectionResult.rows[0];
      const claimToken = crypto.randomUUID();

      const claimResult = await client.query(
        `UPDATE users
         SET firebase_deletion_status = 'IN_PROGRESS',
             firebase_deletion_completed_at = NULL,
             firebase_deletion_last_error = NULL,
             firebase_deletion_claimed_at = NOW(),
             firebase_deletion_claim_token = $4
         WHERE id = $1
           AND firebase_uid = $2
           AND active = false
           AND (
             firebase_deletion_status IN ('PENDING', 'FAILED')
             OR (
               firebase_deletion_status = 'IN_PROGRESS'
               AND firebase_deletion_claimed_at
                 < NOW() - ($3 * INTERVAL '1 millisecond')
             )
           )
         RETURNING
           id,
           firebase_uid,
           firebase_deletion_status,
           firebase_deletion_requested_at,
           firebase_deletion_claim_token`,
        [
          selectedUser.id,
          selectedUser.firebase_uid,
          FIREBASE_DELETION_CLAIM_LEASE_MS,
          claimToken,
        ]
      );

      if (claimResult.rowCount !== 1) {
        await client.query('COMMIT');
        return false;
      }

      claimedUser = claimResult.rows[0];

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        emitProcessEvent(
          'error',
          'firebase_deletion_retry_rollback_failed',
          'database_rollback_failed'
        );
      }

      throw err;
    } finally {
      client.release();
    }
  }

  try {
    await attemptFirebaseDeletion(
      pool,
      claimedUser.id,
      claimedUser.firebase_uid,
      claimedUser.firebase_deletion_claim_token
    );
  } catch (err) {
    emitProcessEvent(
      'error',
      'firebase_deletion_retry_attempt_failed',
      classifyFirebaseDeletionError(err.cause || err)
    );
  }

  return true;
};

let firebaseDeletionRetryWorkerStarted = false;
let firebaseDeletionRetryWorkerStop = null;

const startFirebaseDeletionRetryWorker = (
  pool,
  logEvent
) => {
  if (typeof logEvent === 'function') {
    processLogEvent = logEvent;
  }

  if (firebaseDeletionRetryWorkerStop) {
    return firebaseDeletionRetryWorkerStop;
  }

  firebaseDeletionRetryWorkerStarted = true;

  let stopping = false;
  let activeRun = null;

  const run = () => {
    if (stopping || activeRun) {
      return activeRun;
    }

    activeRun = (async () => {
      try {
        await processFirebaseDeletionRetry(pool);
      } catch (err) {
        emitProcessEvent(
          'error',
          'firebase_deletion_retry_worker_failed',
          'firebase_deletion_worker_internal_error'
        );
      } finally {
        activeRun = null;
      }
    })();

    return activeRun;
  };

  void run();

  const interval = setInterval(() => {
    void run();
  }, 60_000);
  interval.unref?.();

  firebaseDeletionRetryWorkerStop = async () => {
    if (stopping) {
      if (activeRun) {
        await activeRun;
      }
      return;
    }

    stopping = true;
    clearInterval(interval);

    if (activeRun) {
      await activeRun;
    }

    firebaseDeletionRetryWorkerStarted = false;
    firebaseDeletionRetryWorkerStop = null;
  };

  return firebaseDeletionRetryWorkerStop;
};

const authRouter = function authRouter(
  pool,
  verifyToken,
  logEvent
) {
  if (typeof logEvent === 'function') {
    processLogEvent = logEvent;
  }

    const resolveActor = async (req, res, next) => {
    try {
      req.actor = await resolveActorFromDatabase(pool, req);
      return next();
    } catch (err) {
      return sendActorError(req, res, err);
    }
  };

    // [POST] /auth/user-profile - Provision a new customer or update an active existing profile
    router.post(
      '/user-profile',
      verifyToken,
      async (req, res) => {
        const { name, phone } = req.body;
        const firebaseUid = req.user?.uid;
        const firebaseEmail = req.user?.email || null;

        if (!firebaseUid || !firebaseEmail) {
          return res.status(401).json({
            error:
              'Authenticated Firebase identity is required',
          });
        }

        if (!name) {
          return res.status(400).json({
            error: 'Name is required',
          });
        }

        let client;

        try {
          client = await pool.connect();
        } catch {
          return handleError(
            req,
            res,
            'AUTH_PROFILE_DATABASE_CONNECTION_FAILED'
          );
        }

        try {
          await client.query('BEGIN');

          const existingResult = await client.query(
            `SELECT id, active
             FROM users
             WHERE firebase_uid = $1
             FOR UPDATE`,
            [firebaseUid]
          );

          let result;

          if (existingResult.rowCount === 0) {
            result = await client.query(
              `INSERT INTO users (
                 id,
                 firebase_uid,
                 name,
                 email,
                 phone,
                 role,
                 restaurant_id
               )
               VALUES (
                 $1,
                 $2,
                 $3,
                 $4,
                 $5,
                 'Customer',
                 NULL
               )
               RETURNING
                 id,
                 firebase_uid,
                 name,
                 email,
                 phone,
                 role,
                 restaurant_id,
                 active`,
              [
                crypto.randomUUID(),
                firebaseUid,
                name,
                firebaseEmail,
                phone || null,
              ]
            );
          } else {
            if (existingResult.rowCount !== 1) {
              throw new Error(
                'Multiple users found for Firebase identity'
              );
            }

            if (existingResult.rows[0].active !== true) {
              try {
                await client.query('ROLLBACK');
              } catch {
                req.logEvent?.(
                  'error',
                  'auth_route_failed',
                  {
                    reason:
                      'AUTH_PROFILE_ROLLBACK_FAILED',
                  }
                );

                return handleError(
                  req,
                  res,
                  'AUTH_PROFILE_TRANSACTION_FAILED'
                );
              }

              return res.status(403).json({
                error: 'User account is inactive',
              });
            }

            result = await client.query(
              `UPDATE users
               SET name = $1,
                   email = $2,
                   phone = $3
               WHERE firebase_uid = $4
               RETURNING
                 id,
                 firebase_uid,
                 name,
                 email,
                 phone,
                 role,
                 restaurant_id,
                 active`,
              [
                name,
                firebaseEmail,
                phone || null,
                firebaseUid,
              ]
            );

            if (result.rowCount !== 1) {
              throw new Error(
                'Existing user profile update failed'
              );
            }
          }

          await client.query('COMMIT');

          return res.status(200).json({
            message:
              existingResult.rowCount === 0
                ? 'User profile created'
                : 'User profile updated',
            user: result.rows[0],
          });
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            req.logEvent?.(
              'error',
              'auth_route_failed',
              {
                reason:
                  'AUTH_PROFILE_ROLLBACK_FAILED',
              }
            );
          }

          return handleError(req, res);
        } finally {
          client.release();
        }
      }
    );

    // [PUT] /auth/profile - Synchronize the database email from Firebase Authentication
    router.put(
      '/profile',
      verifyToken,
      resolveActor,
      async (req, res) => {
        const firebaseEmail = req.user?.email || null;

        if (!firebaseEmail) {
          return res.status(400).json({
            error: 'Verified Firebase email is required',
          });
        }

        try {
          const result = await pool.query(
            `UPDATE users
             SET email = $1
             WHERE firebase_uid = $2
             RETURNING
               id,
               firebase_uid,
               name,
               email,
               phone,
               role,
               restaurant_id,
               active`,
            [firebaseEmail, req.user.uid]
          );

          if (result.rowCount !== 1) {
            return res.status(404).json({
              error: 'User not found',
            });
          }

          return res.status(200).json({
            message:
              'Profile synchronized with Firebase Authentication',
            user: result.rows[0],
          });
        } catch (err) {
          return handleError(req, res);
        }
      }
    );

    // [DELETE] /auth/delete - Deactivate the database profile and delete the Firebase account
    router.delete(
      '/delete',
      verifyToken,
      resolveActor,
      async (req, res) => {
        const firebaseUid = req.user?.uid;

        if (!firebaseUid) {
          return res.status(401).json({
            error:
              'Authenticated Firebase identity is required',
          });
        }

        if (!req.actor || req.actor.active !== true) {
          return res.status(403).json({
            error: 'User account is inactive',
          });
        }

        let client;

        try {
          client = await pool.connect();
        } catch {
          return handleError(
            req,
            res,
            'AUTH_DELETE_DATABASE_CONNECTION_FAILED'
          );
        }

        try {
          await client.query('BEGIN');

          const claimToken = crypto.randomUUID();

          const result = await client.query(
            `UPDATE users
             SET active = false,
                 firebase_deletion_status = 'IN_PROGRESS',
                 firebase_deletion_requested_at = NOW(),
                 firebase_deletion_completed_at = NULL,
                 firebase_deletion_last_error = NULL,
                 firebase_deletion_claimed_at = NOW(),
                 firebase_deletion_claim_token = $3
             WHERE id = $1
               AND firebase_uid = $2
               AND active = true
               AND firebase_deletion_status = 'NONE'
             RETURNING
               id,
               firebase_uid,
               active,
               firebase_deletion_status,
               firebase_deletion_requested_at,
               firebase_deletion_claim_token`,
            [req.actor.id, firebaseUid, claimToken]
          );

          if (result.rowCount !== 1) {
            try {
              await client.query('ROLLBACK');
            } catch {
              req.logEvent?.(
                'error',
                'auth_route_failed',
                {
                  reason:
                    'AUTH_DELETE_ROLLBACK_FAILED',
                }
              );

              return handleError(
                req,
                res,
                'AUTH_DELETE_TRANSACTION_FAILED'
              );
            }

            return res.status(409).json({
              error:
                'Account deletion could not be initialized',
            });
          }

          const claimedDeletion = result.rows[0];

          await client.query('COMMIT');
          client.release();
          client.released = true;

          try {
            const deletionState =
              await attemptFirebaseDeletion(
                pool,
                claimedDeletion.id,
                claimedDeletion.firebase_uid,
                claimedDeletion.firebase_deletion_claim_token
              );

            return res.status(200).json({
              message: 'User account deleted',
              deletionStatus:
                deletionState.firebase_deletion_status,
            });
          } catch (err) {
            req.logEvent?.(
              'error',
              'firebase_account_deletion_failed',
              {
                reason:
                  classifyFirebaseDeletionError(
                    err.cause || err
                  ),
              }
            );

            return res.status(502).json({
              error:
                'Account deactivated, but Firebase deletion must be retried',
              deletionStatus:
                err.deletionState
                  ?.firebase_deletion_status || 'FAILED',
            });
          }
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            req.logEvent?.(
              'error',
              'auth_route_failed',
              {
                reason:
                  'AUTH_DELETE_ROLLBACK_FAILED',
              }
            );
          }

          return handleError(req, res);
        } finally {
          if (!client.released) {
            client.release();
            client.released = true;
          }
        }
      }
    );

    // [GET] /auth/me - Get Current User Profile
    router.get(
      '/me',
      verifyToken,
      resolveActor,
      async (req, res) => {
        try {
          const result = await pool.query(
            `SELECT
               id,
               firebase_uid,
               name,
               role,
               restaurant_id,
               active
             FROM users
             WHERE firebase_uid = $1`,
            [req.user.uid]
          );

          if (result.rowCount !== 1) {
            return res.status(404).json({
              error: 'User not found',
            });
          }

          return res.status(200).json({
            user: result.rows[0],
          });
        } catch (err) {
          return handleError(req, res);
        }
      }
    );

    router.get(
      '/claims',
      verifyToken,
      resolveActor,
      async (req, res) => {
        return res.status(200).json({
          uid: req.user?.uid,
          email: req.user?.email || null,
          role: req.actor?.role || null,
          restaurantId:
            req.actor?.restaurantId || null,
          actorId: req.actor?.id || null,
          active: req.actor?.active ?? null,
        });
      }
    );

    return router;
};

module.exports = authRouter;
module.exports.startFirebaseDeletionRetryWorker =
  startFirebaseDeletionRetryWorker;
