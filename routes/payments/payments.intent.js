const express = require('express');
const config = require('../../config');

// Middleware (adjust paths if your project uses a different structure)
const verifyToken = require('../../middleware/verifyToken');
const {
  resolveActor,
  sendActorError,
} = require('../../middleware/resolveActor');

const {
  reconcileSucceededPayment,
} = require('./payments.webhook');

const router = express.Router();

// PaymentIntent statuses that can be reused by returning the client_secret
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

function getPool(req) {
  const pool = req?.app?.get?.('pool');

  if (!pool) {
    throw new Error('DATABASE_POOL_UNAVAILABLE');
  }

  return pool;
}

const MANAGER_PAYMENT_ROLES = new Set(['Owner', 'Manager']);

function canPayOrder(actor, order) {
  if (!actor || !order) return false;
  if (MANAGER_PAYMENT_ROLES.has(actor.role)) return true;

  return (
    String(order.created_by_user_id || '') ===
    String(actor.userId || '')
  );
}

// Payment cycle: Order-anchored PaymentIntent + idempotency +
// webhook reconciliation.
//
// POST /api/payments/intent
// Body: { orderId } or { order_id }
router.post(
  '/intent',
  verifyToken,
  async (req, res) => {
    try {
      const stripeKey = String(
        config.stripe.secretKey || ''
      ).trim();

      if (!stripeKey) {
        req.logEvent?.(
          'error',
          'payment_intent_failed',
          {
            reason: 'STRIPE_CONFIGURATION_UNAVAILABLE',
          }
        );

        return res.status(503).json({
          error: 'Payments unavailable',
        });
      }

      const stripe = require('stripe')(stripeKey);

      const idempotencyKey = String(
        req.get('Idempotency-Key') ||
        req.get('idempotency-key') ||
        ''
      ).trim();

      if (!idempotencyKey) {
        return res.status(400).json({
          error: 'Missing Idempotency-Key header',
        });
      }

      const orderId =
        req.body?.orderId ||
        req.body?.order_id;

      if (!orderId) {
        return res.status(400).json({
          error: 'Missing orderId',
        });
      }

      const pool = getPool(req);

      let actor;

      try {
        actor = await resolveActor(pool, req);

      } catch (error) {
        return sendActorError(req, res, error);
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const orderQ = await client.query(
          `SELECT
             id,
             restaurant_id,
             created_by_user_id,
             total_cents,
             paid_cents,
             status
           FROM orders
           WHERE id = $1
             AND restaurant_id = $2
           FOR UPDATE`,
          [
            orderId,
            actor.restaurantId,
          ]
        );

        if (orderQ.rowCount === 0) {
          await client.query('ROLLBACK');

          return res.status(404).json({
            error: 'Order not found',
          });
        }

        const order = orderQ.rows[0];

        if (!canPayOrder(actor, order)) {
          await client.query('ROLLBACK');

          return res.status(403).json({
            error: 'Forbidden',
          });
        }

        const restaurantId = order.restaurant_id;
        const totalCents = Number(
          order.total_cents || 0
        );
        const paidCents = Number(
          order.paid_cents || 0
        );
        const remainingCents =
          totalCents - paidCents;

        let reusable = null;

        try {
          const payQ = await client.query(
            `SELECT
               order_id,
               restaurant_id,
               amount_cents,
               payment_intent_id,
               status
             FROM payments
             WHERE order_id = $1
               AND restaurant_id = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [
              orderId,
              restaurantId,
            ]
          );

          if (
            payQ.rowCount > 0 &&
            payQ.rows[0]?.payment_intent_id
          ) {
            reusable = {
              order_id: payQ.rows[0].order_id
                ? String(payQ.rows[0].order_id)
                : null,
              restaurant_id: payQ.rows[0].restaurant_id
                ? String(payQ.rows[0].restaurant_id)
                : null,
              amount_cents: Number.isInteger(
                Number(payQ.rows[0].amount_cents)
              )
                ? Number(payQ.rows[0].amount_cents)
                : null,
              payment_intent_id: String(
                payQ.rows[0].payment_intent_id
              ),
              status: payQ.rows[0].status
                ? String(payQ.rows[0].status)
                : null,
            };
          }
        } catch {
          req.logEvent?.(
            'error',
            'payment_intent_failed',
            {
              reason: 'PAYMENT_LOOKUP_FAILED',
            }
          );

          throw new Error(
            'PAYMENT_LOOKUP_FAILED'
          );
        }

        if (reusable?.payment_intent_id) {
          const existing =
            await stripe.paymentIntents.retrieve(
              reusable.payment_intent_id
            );

          const existingAmountMatches =
            Number.isInteger(existing?.amount) &&
            existing.amount === remainingCents;

          const existingSucceededAmountMatches =
            Number.isInteger(existing?.amount) &&
            Number.isInteger(reusable.amount_cents) &&
            existing.amount === reusable.amount_cents;

          const existingCurrencyMatches =
            String(existing?.currency || '')
              .trim()
              .toLowerCase() === 'usd';

          const existingMetadataMatches =
            String(existing?.metadata?.order_id || '') ===
            String(orderId);

          const persistedIdentityMatches =
            String(reusable.order_id || '') ===
              String(orderId) &&
            String(reusable.restaurant_id || '') ===
              String(restaurantId) &&
            String(reusable.payment_intent_id || '') ===
              String(existing?.id || '');

          const persistedRemainingAmountMatches =
            reusable.amount_cents === remainingCents;

          const existingSucceeded =
            String(existing?.status || '')
              .trim()
              .toLowerCase() === 'succeeded';

          const existingStatusReusable =
            Boolean(existing) &&
            REUSABLE_INTENT_STATUSES.has(
              existing.status
            );

          const existingMatchesOrder =
            remainingCents > 0 &&
            existingStatusReusable &&
            existingAmountMatches &&
            existingCurrencyMatches &&
            existingMetadataMatches &&
            persistedIdentityMatches &&
            persistedRemainingAmountMatches;

          if (existingMatchesOrder) {
            await client.query('COMMIT');

            return res.json({
              paymentIntentId: existing.id,
              paymentIntentClientSecret:
                existing.client_secret,
              amountCents: remainingCents,
              reused: true,
            });
          }

          req.logEvent?.(
            'info',
            'payment_intent_reconciliation_decision',
            {
              existingSucceeded,
              existingSucceededAmountMatches,
              existingCurrencyMatches,
              existingMetadataMatches,
              persistedIdentityMatches,
              remainingBalancePositive:
                Number.isFinite(remainingCents) &&
                remainingCents > 0,
            }
          );

          if (
            existingSucceeded &&
            existingSucceededAmountMatches &&
            existingCurrencyMatches &&
            existingMetadataMatches &&
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
              paymentIntentId: existing.id,
              amountCents: existing.amount,
              paymentCompleted: true,
              reconciled:
                !reconciliation.deduplicated,
              reused: false,
            });
          }

          req.logEvent?.(
            'error',
            'payment_intent_failed',
            {
              reason:
                'PAYMENT_INTENT_REUSE_INCOMPATIBLE',
            }
          );

          throw new Error(
            'PAYMENT_INTENT_REUSE_INCOMPATIBLE'
          );
        }

        if (
          !Number.isFinite(remainingCents) ||
          remainingCents <= 0
        ) {
          await client.query('ROLLBACK');

          return res.status(409).json({
            error: 'Order already paid',
          });
        }

        const paymentIntent =
          await stripe.paymentIntents.create(
            {
              amount: remainingCents,
              currency: 'usd',
              automatic_payment_methods: {
                enabled: true,
              },
              metadata: {
                order_id: String(orderId),
              },
            },
            {
              idempotencyKey,
            }
          );

        let statusEnum;

        try {
          statusEnum =
            toPaymentStatusEnum(
              paymentIntent.status
            );

        } catch {
          req.logEvent?.(
            'error',
            'payment_intent_failed',
            {
              reason:
                'STRIPE_PAYMENT_STATUS_UNSUPPORTED',
            }
          );

          throw new Error(
            'STRIPE_PAYMENT_STATUS_UNSUPPORTED'
          );
        }

        try {
          const amountCents =
            Number.isInteger(paymentIntent.amount)
              ? paymentIntent.amount
              : remainingCents;

          await client.query(
            `INSERT INTO payments (
               order_id,
               restaurant_id,
               payment_intent_id,
               stripe_payment_intent_id,
               status,
               amount_cents
             )
             VALUES (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6
             )
             ON CONFLICT (payment_intent_id)
             DO UPDATE SET
               order_id =
                 EXCLUDED.order_id,
               restaurant_id =
                 EXCLUDED.restaurant_id,
               stripe_payment_intent_id =
                 EXCLUDED.stripe_payment_intent_id,
               status =
                 EXCLUDED.status,
               amount_cents =
                 EXCLUDED.amount_cents`,
            [
              orderId,
              restaurantId,
              paymentIntent.id,
              paymentIntent.id,
              statusEnum,
              amountCents,
            ]
          );
        } catch {
          req.logEvent?.(
            'error',
            'payment_intent_failed',
            {
              reason:
                'PAYMENT_PERSISTENCE_FAILED',
            }
          );

          throw new Error(
            'PAYMENT_PERSISTENCE_FAILED'
          );
        }

        await client.query('COMMIT');

        return res.json({
          paymentIntentId:
            paymentIntent.id,
          paymentIntentClientSecret:
            paymentIntent.client_secret,
          amountCents: remainingCents,
          reused: false,
        });
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          req.logEvent?.(
            'error',
            'payment_intent_failed',
            {
              reason:
                'PAYMENT_TRANSACTION_ROLLBACK_FAILED',
            }
          );
        }

        throw error;
      } finally {
        client.release();
      }
    } catch {
      req.logEvent?.(
        'error',
        'payment_intent_failed',
        {
          reason:
            'PAYMENT_INTENT_OPERATION_FAILED',
        }
      );

      return res.status(500).json({
        error:
          'Failed to create payment intent',
      });
    }
  }
);

module.exports = router;
