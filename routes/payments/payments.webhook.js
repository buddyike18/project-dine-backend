// File: routes/payments/payments.webhook.js
//
// Deterministic, idempotent, auditable Stripe webhook handler.
//
// This route must receive the original request body as a Buffer through
// express.raw({ type: 'application/json' }).

const STRIPE_STATUS_TO_DB = {
  created: 'REQUIRES_PAYMENT_METHOD',
  requires_payment_method: 'REQUIRES_PAYMENT_METHOD',
  requires_confirmation: 'REQUIRES_CONFIRMATION',

  // The current payment_status enum does not contain REQUIRES_ACTION.
  // Preserve the nonterminal state using the nearest supported value.
  requires_action: 'REQUIRES_CONFIRMATION',

  processing: 'PROCESSING',
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  canceled: 'CANCELLED',
};

const STATE_RANK = {
  REQUIRES_PAYMENT: 0,
  REQUIRES_PAYMENT_METHOD: 1,
  REQUIRES_CONFIRMATION: 2,
  PROCESSING: 3,
  SUCCEEDED: 4,
  FAILED: 5,
  CANCELLED: 5,
};

function classifiedError(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

function toDbStatus(status) {
  const normalized = String(status || '')
    .trim()
    .toLowerCase();

  return (
    STRIPE_STATUS_TO_DB[normalized] ||
    String(status || '').trim().toUpperCase()
  );
}

function isForwardOrEqual(currentStatus, nextStatus) {
  const current = toDbStatus(
    currentStatus || 'REQUIRES_PAYMENT'
  );

  const next = toDbStatus(nextStatus);

  if (current === 'CANCELLED') {
    return next === 'CANCELLED';
  }

  if (next === 'SUCCEEDED') {
    return true;
  }

  if (
    next === 'FAILED' ||
    next === 'CANCELLED'
  ) {
    return current !== 'SUCCEEDED';
  }

  const currentRank =
    STATE_RANK[current] ?? -1;

  const nextRank =
    STATE_RANK[next] ?? -1;

  return nextRank >= currentRank;
}

async function findPaymentByIntent(
  client,
  paymentIntentId
) {
  try {
    const result = await client.query(
      `SELECT
         id,
         restaurant_id,
         order_id,
         payment_intent_id,
         stripe_payment_intent_id,
         status,
         amount_cents,
         created_at
       FROM payments
       WHERE payment_intent_id = $1
          OR stripe_payment_intent_id = $1
       ORDER BY
         (order_id IS NOT NULL) DESC,
         created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [paymentIntentId]
    );

    return result.rows[0] || null;
  } catch {
    throw classifiedError(
      'PAYMENT_LOOKUP_FAILED'
    );
  }
}

async function findPaymentOrder(
  client,
  paymentIntentId
) {
  try {
    const result = await client.query(
      `SELECT
         p.id AS payment_id,
         p.restaurant_id
           AS payment_restaurant_id,
         p.order_id
           AS payment_order_id,
         p.payment_intent_id,
         p.stripe_payment_intent_id,
         p.status
           AS payment_status,
         p.amount_cents
           AS payment_amount_cents,
         p.created_at
           AS payment_created_at,

         o.id AS order_id,
         o.restaurant_id
           AS order_restaurant_id,
         o.total_cents
           AS order_total_cents,
         o.paid_cents
           AS order_paid_cents,
         o.status
           AS order_status,
         o.order_origin
           AS order_origin

       FROM payments p

       JOIN orders o
         ON o.id = p.order_id

       WHERE (
         p.payment_intent_id = $1
         OR
         p.stripe_payment_intent_id = $1
       )

       ORDER BY p.created_at DESC

       LIMIT 1

       FOR UPDATE OF p, o`,
      [paymentIntentId]
    );

    return result.rows[0] || null;
  } catch {
    throw classifiedError(
      'PAYMENT_ORDER_LOOKUP_FAILED'
    );
  }
}

async function paymentRecordedEventExists(
  client,
  restaurantId,
  orderId,
  paymentIntentId
) {
  const idempotencyKey =
    `stripe-payment:${paymentIntentId}`;

  try {
    const result = await client.query(
      `SELECT 1
       FROM order_events
       WHERE restaurant_id = $1
         AND order_id = $2
         AND event_type = 'PAYMENT_RECORDED'
         AND idempotency_key = $3
       LIMIT 1`,
      [
        restaurantId,
        orderId,
        idempotencyKey,
      ]
    );

    return result.rowCount === 1;
  } catch {
    throw classifiedError(
      'PAYMENT_RECORDED_EVENT_LOOKUP_FAILED'
    );
  }
}

function validatePaymentOrder(
  row,
  stripeAmountCents
) {
  if (!row) {
    throw classifiedError(
      'PAYMENT_ORDER_NOT_FOUND'
    );
  }

  if (
    !row.payment_order_id ||
    !row.order_id ||
    String(row.payment_order_id) !==
      String(row.order_id)
  ) {
    throw classifiedError(
      'PAYMENT_ORDER_ID_MISMATCH'
    );
  }

  if (
    !row.payment_restaurant_id ||
    !row.order_restaurant_id ||
    String(row.payment_restaurant_id) !==
      String(row.order_restaurant_id)
  ) {
    throw classifiedError(
      'PAYMENT_RESTAURANT_SCOPE_MISMATCH'
    );
  }

  const paymentAmountCents = Number(
    row.payment_amount_cents
  );

  const orderTotalCents = Number(
    row.order_total_cents
  );

  const orderPaidCents = Number(
    row.order_paid_cents || 0
  );

  const remainingCents =
    orderTotalCents - orderPaidCents;

  if (
    !Number.isInteger(paymentAmountCents) ||
    paymentAmountCents <= 0
  ) {
    throw classifiedError(
      'PAYMENT_AMOUNT_INVALID'
    );
  }

  if (
    !Number.isInteger(orderTotalCents) ||
    orderTotalCents <= 0 ||
    paymentAmountCents > orderTotalCents
  ) {
    throw classifiedError(
      'PAYMENT_ORDER_AMOUNT_INVALID'
    );
  }

  if (
    !Number.isInteger(remainingCents) ||
    remainingCents <= 0 ||
    paymentAmountCents !==
      remainingCents
  ) {
    throw classifiedError(
      'PAYMENT_REMAINING_BALANCE_MISMATCH'
    );
  }

  if (
    !Number.isInteger(stripeAmountCents) ||
    stripeAmountCents !==
      paymentAmountCents
  ) {
    throw classifiedError(
      'STRIPE_PAYMENT_AMOUNT_MISMATCH'
    );
  }

  return {
    paymentId: row.payment_id,
    orderId: row.order_id,
    restaurantId:
      row.order_restaurant_id,
    orderStatus: row.order_status,
    orderOrigin: row.order_origin,
    paymentAmountCents,
    stripeAmountCents,
    orderTotalCents,
    orderPaidCents,
    remainingCents,
  };
}

async function updatePaymentStatus(
  client,
  payment,
  nextStatus,
  amountCents
) {
  const currentStatus = toDbStatus(
    payment.status ||
    'REQUIRES_PAYMENT'
  );

  const normalizedNextStatus =
    toDbStatus(nextStatus);

  if (
    !isForwardOrEqual(
      currentStatus,
      normalizedNextStatus
    )
  ) {
    return {
      updated: false,
      status: currentStatus,
    };
  }

  try {
    const result = await client.query(
      `UPDATE payments
       SET status = $2,
           amount_cents =
             COALESCE(
               $3,
               amount_cents
             )
       WHERE id = $1
       RETURNING status`,
      [
        payment.id,
        normalizedNextStatus,
        Number.isInteger(amountCents)
          ? amountCents
          : null,
      ]
    );

    if (result.rowCount !== 1) {
      throw classifiedError(
        'PAYMENT_STATUS_UPDATE_MISSING'
      );
    }

    return {
      updated: true,
      status: result.rows[0].status,
    };
  } catch (error) {
    if (error?.reason) throw error;

    throw classifiedError(
      'PAYMENT_STATUS_UPDATE_FAILED'
    );
  }
}

async function insertPaymentRecordedEvent(
  client,
  relationship,
  paymentIntentId
) {
  const idempotencyKey =
    `stripe-payment:${paymentIntentId}`;

  const meta = {
    provider: 'STRIPE',
    payment_reference:
      paymentIntentId,
    amount_cents: String(
      relationship.paymentAmountCents
    ),
  };

  try {
    const result = await client.query(
      `INSERT INTO order_events (
         restaurant_id,
         order_id,
         event_type,
         from_status,
         to_status,
         actor_role,
         actor_user_id,
         actor_firebase_uid,
         actor_type,
         idempotency_key,
         meta
       )
       VALUES (
         $1,
         $2,
         'PAYMENT_RECORDED',
         NULL,
         NULL,
         NULL,
         NULL,
         NULL,
         'PAYMENT_PROVIDER',
         $3,
         $4::jsonb
       )
       ON CONFLICT (
         restaurant_id,
         event_type,
         idempotency_key,
         (
           CASE
             WHEN actor_user_id IS NOT NULL
               THEN 'user:' || actor_user_id::text
             WHEN actor_firebase_uid IS NOT NULL
               THEN 'firebase:' || actor_firebase_uid
             ELSE 'system'
           END
         )
       )
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        relationship.restaurantId,
        relationship.orderId,
        idempotencyKey,
        JSON.stringify(meta),
      ]
    );

    return result.rowCount === 1;
  } catch {
    throw classifiedError(
      'PAYMENT_RECORDED_EVENT_INSERT_FAILED'
    );
  }
}

async function markOrderPaid(
  client,
  relationship
) {
  try {
    const result = await client.query(
      `UPDATE orders
       SET paid_cents =
         COALESCE(paid_cents, 0) + $3
       WHERE id = $1
         AND restaurant_id = $2
         AND $3 > 0
         AND COALESCE(paid_cents, 0) + $3 <=
             COALESCE(total_cents, 0)
       RETURNING
         id,
         restaurant_id,
         paid_cents,
         total_cents,
         status,
         order_origin`,
      [
        relationship.orderId,
        relationship.restaurantId,
        relationship.paymentAmountCents,
      ]
    );

    if (result.rowCount !== 1) {
      throw classifiedError(
        'ORDER_PAYMENT_UPDATE_REJECTED'
      );
    }

    return {
      updated: true,
      order: result.rows[0],
    };
  } catch (error) {
    if (error?.reason) throw error;

    throw classifiedError(
      'ORDER_PAYMENT_UPDATE_FAILED'
    );
  }
}

async function autoSendCustomerOrder(
  client,
  relationship
) {
  try {
    const result = await client.query(
      `UPDATE orders
       SET status = 'SENT',
           sent_at =
             COALESCE(
               sent_at,
               NOW()
             )
       WHERE id = $1
         AND restaurant_id = $2
         AND status = 'OPEN'
         AND COALESCE(paid_cents, 0) >=
             COALESCE(total_cents, 0)
         AND order_origin = 'CUSTOMER'
       RETURNING
         id,
         restaurant_id,
         status,
         sent_at`,
      [
        relationship.orderId,
        relationship.restaurantId,
      ]
    );

    return result.rows[0] || null;
  } catch {
    throw classifiedError(
      'ORDER_AUTO_SEND_FAILED'
    );
  }
}

async function insertSentStatusEvent(
  client,
  relationship,
  paymentIntentId
) {
  const idempotencyKey =
    `stripe-status-sent:${paymentIntentId}`;

  const meta = {
    provider: 'STRIPE',
    payment_reference:
      paymentIntentId,
    reason:
      'CUSTOMER_ORDER_PAYMENT_COMPLETED',
  };

  try {
    const result = await client.query(
      `INSERT INTO order_events (
         restaurant_id,
         order_id,
         event_type,
         from_status,
         to_status,
         actor_role,
         actor_user_id,
         actor_firebase_uid,
         actor_type,
         idempotency_key,
         meta
       )
       VALUES (
         $1,
         $2,
         'STATUS_CHANGED',
         'OPEN',
         'SENT',
         NULL,
         NULL,
         NULL,
         'SYSTEM',
         $3,
         $4::jsonb
       )
       ON CONFLICT (
         restaurant_id,
         event_type,
         idempotency_key,
         (
           CASE
             WHEN actor_user_id IS NOT NULL
               THEN 'user:' || actor_user_id::text
             WHEN actor_firebase_uid IS NOT NULL
               THEN 'firebase:' || actor_firebase_uid
             ELSE 'system'
           END
         )
       )
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        relationship.restaurantId,
        relationship.orderId,
        idempotencyKey,
        JSON.stringify(meta),
      ]
    );

    return result.rowCount === 1;
  } catch {
    throw classifiedError(
      'STATUS_CHANGED_EVENT_INSERT_FAILED'
    );
  }
}

async function applySucceededPaymentSettlement(
  client,
  payment,
  relationship,
  paymentIntentId,
  stripeAmountCents,
  eventType
) {
  const paymentUpdate =
    await updatePaymentStatus(
      client,
      payment,
      'SUCCEEDED',
      stripeAmountCents
    );

  const effects = {
    eventType,
    paymentIntentId,
    paymentId: payment.id,
    orderId:
      relationship?.orderId ||
      payment.order_id ||
      null,
    restaurantId:
      relationship?.restaurantId ||
      payment.restaurant_id ||
      null,
    fromStatus:
      payment.status || null,
    toStatus:
      paymentUpdate.status,
    monotonicIgnored:
      !paymentUpdate.updated,
    paymentRecorded: false,
    orderPaid: false,
    orderSent: false,
    statusChangedRecorded: false,
  };

  effects.paymentRecorded =
    await insertPaymentRecordedEvent(
      client,
      relationship,
      paymentIntentId
    );

  const paidResult =
    await markOrderPaid(
      client,
      relationship
    );

  effects.orderPaid =
    paidResult.updated;

  effects.orderPaidCents =
    paidResult.order?.paid_cents ??
    null;

  const sentOrder =
    await autoSendCustomerOrder(
      client,
      relationship
    );

  if (sentOrder) {
    effects.orderSent = true;

    effects.statusChangedRecorded =
      await insertSentStatusEvent(
        client,
        relationship,
        paymentIntentId
      );

    effects.orderStatus =
      'SENT';

    effects.orderSentAt =
      sentOrder.sent_at;
  } else {
    effects.orderStatus =
      paidResult.order?.status ||
      null;
  }

  return effects;
}


async function reconcileSucceededPayment(
  client,
  paymentIntentId,
  stripeAmountCents,
  eventType = 'payment_intent.succeeded'
) {
  const payment =
    await findPaymentByIntent(
      client,
      paymentIntentId
    );

  const paymentOrder =
    await findPaymentOrder(
      client,
      paymentIntentId
    );

  if (!paymentOrder) {
    throw classifiedError(
      'PAYMENT_ORDER_NOT_FOUND'
    );
  }

  if (
    String(payment.order_id || '') !==
    String(paymentOrder.order_id || '')
  ) {
    throw classifiedError(
      'PAYMENT_ORDER_RELATIONSHIP_MISMATCH'
    );
  }

  if (
    String(payment.restaurant_id || '') !==
    String(
      paymentOrder.order_restaurant_id ||
      ''
    )
  ) {
    throw classifiedError(
      'PAYMENT_RESTAURANT_RELATIONSHIP_MISMATCH'
    );
  }

  const paymentStatus =
    String(payment.status || '')
      .trim()
      .toUpperCase();

  const orderTotalCents =
    Number(paymentOrder.order_total_cents);

  const orderPaidCents =
    Number(paymentOrder.order_paid_cents);

  const paymentAlreadyRecorded =
    await paymentRecordedEventExists(
      client,
      paymentOrder.order_restaurant_id,
      paymentOrder.order_id,
      paymentIntentId
    );

  const alreadyApplied =
    paymentStatus === 'SUCCEEDED' &&
    Number.isInteger(orderTotalCents) &&
    orderTotalCents > 0 &&
    Number.isInteger(orderPaidCents) &&
    orderPaidCents >= orderTotalCents &&
    paymentAlreadyRecorded;

  if (alreadyApplied) {
    const relationship = {
      paymentId:
        paymentOrder.payment_id,
      orderId:
        paymentOrder.order_id,
      restaurantId:
        paymentOrder.order_restaurant_id,
      orderStatus:
        paymentOrder.order_status,
      orderOrigin:
        paymentOrder.order_origin,
      paymentAmountCents:
        Number(
          paymentOrder.payment_amount_cents
        ),
      stripeAmountCents,
      orderTotalCents,
      orderPaidCents,
      remainingCents:
        orderTotalCents -
        orderPaidCents,
    };

    return {
      deduplicated: true,
      payment,
      relationship,
      effects: {
        eventType,
        paymentIntentId,
        paymentId: payment.id,
        orderId: relationship.orderId,
        restaurantId:
          relationship.restaurantId,
        fromStatus: paymentStatus,
        toStatus: paymentStatus,
        monotonicIgnored: true,
        paymentRecorded: false,
        orderPaid: false,
        orderSent: false,
        statusChangedRecorded: false,
        orderStatus:
          paymentOrder.order_status || null,
        orderPaidCents,
      },
    };
  }

  const relationship =
    validatePaymentOrder(
      paymentOrder,
      stripeAmountCents
    );

  const effects =
    await applySucceededPaymentSettlement(
      client,
      payment,
      relationship,
      paymentIntentId,
      stripeAmountCents,
      eventType
    );

  return {
    deduplicated: false,
    payment,
    relationship,
    effects,
  };
}

function createPaymentsWebhookRouter(pool) {
  const express = require('express');
  const config = require('../../config');

  const router = express.Router();

  const stripeSecretKey = String(
    config.stripe.secretKey || ''
  ).trim();

  const webhookSecret = String(
    config.stripe.webhookSecret || ''
  ).trim();

  if (!stripeSecretKey) {
    throw new Error('STRIPE_CONFIGURATION_UNAVAILABLE');
  }

  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_CONFIGURATION_UNAVAILABLE');
  }

  const stripe = require('stripe')(stripeSecretKey);

  const SUPPORTED_EVENTS = new Set([
    'payment_intent.created',
    'payment_intent.processing',
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'payment_intent.canceled',
    'payment_intent.requires_action',
    'payment_intent.requires_payment_method',
    'payment_intent.requires_confirmation',
    'charge.succeeded',
  ]);




  function getFailureReason(error) {
    const reason = error?.reason;

    if (
      typeof reason === 'string' &&
      /^[A-Z0-9_]{1,80}$/.test(reason)
    ) {
      return reason;
    }

    return 'WEBHOOK_PROCESSING_FAILED';
  }



  function nextStatusFromEvent(eventType) {
    switch (eventType) {
      case 'payment_intent.created':
        return 'REQUIRES_PAYMENT_METHOD';

      case 'payment_intent.processing':
        return 'PROCESSING';

      case 'payment_intent.succeeded':
      case 'charge.succeeded':
        return 'SUCCEEDED';

      case 'payment_intent.payment_failed':
        return 'FAILED';

      case 'payment_intent.canceled':
        return 'CANCELLED';

      case 'payment_intent.requires_action':
        return 'REQUIRES_CONFIRMATION';

      case 'payment_intent.requires_payment_method':
        return 'REQUIRES_PAYMENT_METHOD';

      case 'payment_intent.requires_confirmation':
        return 'REQUIRES_CONFIRMATION';

      default:
        return null;
    }
  }

  function extractPaymentIntentId(eventType, object) {
    if (
      String(eventType).startsWith('charge.')
    ) {
      return object?.payment_intent
        ? String(object.payment_intent)
        : null;
    }

    return object?.id
      ? String(object.id)
      : null;
  }

  function extractStripeAmountCents(
    eventType,
    object
  ) {
    if (
      String(eventType).startsWith('charge.')
    ) {
      if (
        Number.isInteger(
          object?.amount_captured
        )
      ) {
        return object.amount_captured;
      }

      if (Number.isInteger(object?.amount)) {
        return object.amount;
      }

      return null;
    }

    if (
      eventType ===
        'payment_intent.succeeded' &&
      Number.isInteger(
        object?.amount_received
      )
    ) {
      return object.amount_received;
    }

    if (Number.isInteger(object?.amount)) {
      return object.amount;
    }

    return null;
  }

  async function registerWebhookEvent(event) {
    try {
      const result = await pool.query(
        `INSERT INTO stripe_webhook_events (
           event_id,
           type,
           livemode,
           stripe_created,
           object_id,
           request_id,
           api_version,
           payload,
           status
         )
         VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           $6,
           $7,
           $8::jsonb,
           'received'
         )
         ON CONFLICT (event_id)
         DO NOTHING
         RETURNING event_id`,
        [
          event.id,
          event.type,
          Boolean(event.livemode),
          Number.isInteger(event.created)
            ? event.created
            : null,
          event.data?.object?.id
            ? String(event.data.object.id)
            : null,
          event.request?.id
            ? String(event.request.id)
            : null,
          event.api_version
            ? String(event.api_version)
            : null,
          JSON.stringify(event),
        ]
      );

      return result.rowCount === 1;
    } catch {
      throw classifiedError(
        'WEBHOOK_EVENT_REGISTRATION_FAILED'
      );
    }
  }

  async function lockWebhookEvent(
    client,
    eventId
  ) {
    try {
      const result = await client.query(
        `SELECT event_id, status
         FROM stripe_webhook_events
         WHERE event_id = $1
         FOR UPDATE`,
        [eventId]
      );

      if (result.rowCount !== 1) {
        throw classifiedError(
          'WEBHOOK_EVENT_REGISTRATION_MISSING'
        );
      }

      return result.rows[0];
    } catch (error) {
      if (error?.reason) throw error;

      throw classifiedError(
        'WEBHOOK_EVENT_LOCK_FAILED'
      );
    }
  }

  async function markWebhookEvent(
    client,
    eventId,
    status,
    effects,
    reason
  ) {
    try {
      await client.query(
        `UPDATE stripe_webhook_events
         SET status = $2,
             processed_at =
               CASE
                 WHEN $2 IN (
                   'processed',
                   'ignored',
                   'failed'
                 )
                 THEN NOW()
                 ELSE processed_at
               END,
             effects =
               COALESCE(
                 $3::jsonb,
                 effects
               ),
             error_message = $4
         WHERE event_id = $1`,
        [
          eventId,
          status,
          effects
            ? JSON.stringify(effects)
            : null,
          reason || null,
        ]
      );
    } catch {
      throw classifiedError(
        'WEBHOOK_EVENT_STATUS_UPDATE_FAILED'
      );
    }
  }

  async function markWebhookFailure(
    eventId,
    reason
  ) {
    try {
      const result = await pool.query(
        `UPDATE stripe_webhook_events
         SET status = 'failed',
             processed_at = NOW(),
             error_message = $2
         WHERE event_id = $1`,
        [
          eventId,
          reason,
        ]
      );

      return result.rowCount === 1;
    } catch {
      return false;
    }
  }











  async function handler(req, res) {
    const signature =
      req.headers['stripe-signature'];

    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody)) {
      req.logEvent?.(
        'warn',
        'payment_webhook_rejected',
        {
          reason:
            'WEBHOOK_RAW_BODY_REQUIRED',
        }
      );

      return res.status(400).json({
        error: 'Invalid webhook request',
      });
    }

    if (!signature) {
      req.logEvent?.(
        'warn',
        'payment_webhook_rejected',
        {
          reason:
            'WEBHOOK_SIGNATURE_MISSING',
        }
      );

      return res.status(400).json({
        error: 'Invalid webhook request',
      });
    }

    let event;

    try {
      event =
        stripe.webhooks.constructEvent(
          rawBody,
          signature,
          webhookSecret
        );
    } catch {
      req.logEvent?.(
        'warn',
        'payment_webhook_rejected',
        {
          reason:
            'WEBHOOK_SIGNATURE_INVALID',
        }
      );

      return res.status(400).json({
        error: 'Invalid webhook request',
      });
    }

    try {
      await registerWebhookEvent(event);
    } catch (error) {
      req.logEvent?.(
        'error',
        'payment_webhook_failed',
        {
          reason:
            getFailureReason(error),
        }
      );

      return res.status(500).json({
        error: 'Webhook processing failed',
      });
    }

    let client;

    try {
      client = await pool.connect();
    } catch {
      const failureRecorded =
        await markWebhookFailure(
          event.id,
          'WEBHOOK_DATABASE_CONNECTION_FAILED'
        );

      if (!failureRecorded) {
        req.logEvent?.(
          'error',
          'payment_webhook_failed',
          {
            reason:
              'WEBHOOK_FAILURE_STATUS_PERSISTENCE_FAILED',
          }
        );
      }

      req.logEvent?.(
        'error',
        'payment_webhook_failed',
        {
          reason:
            'WEBHOOK_DATABASE_CONNECTION_FAILED',
        }
      );

      return res.status(500).json({
        error: 'Webhook processing failed',
      });
    }

    try {
      await client.query('BEGIN');

      const storedEvent =
        await lockWebhookEvent(
          client,
          event.id
        );

      if (
        storedEvent.status ===
          'processed' ||
        storedEvent.status ===
          'ignored'
      ) {
        await client.query('ROLLBACK');

        return res.status(200).json({
          ok: true,
          deduped: true,
        });
      }

      if (
        !SUPPORTED_EVENTS.has(event.type)
      ) {
        await markWebhookEvent(
          client,
          event.id,
          'ignored',
          {
            reason:
              'UNSUPPORTED_EVENT_TYPE',
          },
          null
        );

        await client.query('COMMIT');

        return res.status(200).json({
          ok: true,
          ignored: true,
        });
      }

      const object = event.data?.object;

      const paymentIntentId =
        extractPaymentIntentId(
          event.type,
          object
        );

      const nextStatus =
        nextStatusFromEvent(event.type);

      if (
        !paymentIntentId ||
        !nextStatus
      ) {
        await markWebhookEvent(
          client,
          event.id,
          'ignored',
          {
            reason:
              'PAYMENT_INTENT_REFERENCE_MISSING',
          },
          null
        );

        await client.query('COMMIT');

        return res.status(200).json({
          ok: true,
          ignored: true,
        });
      }

      const payment =
        await findPaymentByIntent(
          client,
          paymentIntentId
        );

      if (!payment) {
        throw classifiedError(
          'AUTHORITATIVE_PAYMENT_NOT_FOUND'
        );
      }

      const stripeAmountCents =
        extractStripeAmountCents(
          event.type,
          object
        );

      let relationship = null;

      if (
        nextStatus === 'SUCCEEDED'
      ) {
        const paymentOrder =
          await findPaymentOrder(
            client,
            paymentIntentId
          );

        if (!paymentOrder) {
          throw classifiedError(
            'PAYMENT_ORDER_NOT_FOUND'
          );
        }

        if (
          !paymentOrder.payment_order_id ||
          !paymentOrder.order_id ||
          String(
            paymentOrder.payment_order_id
          ) !==
            String(paymentOrder.order_id)
        ) {
          throw classifiedError(
            'PAYMENT_ORDER_ID_MISMATCH'
          );
        }

        if (
          !paymentOrder.payment_restaurant_id ||
          !paymentOrder.order_restaurant_id ||
          String(
            paymentOrder.payment_restaurant_id
          ) !==
            String(
              paymentOrder.order_restaurant_id
            )
        ) {
          throw classifiedError(
            'PAYMENT_RESTAURANT_SCOPE_MISMATCH'
          );
        }

        const paymentStatus =
          toDbStatus(
            paymentOrder.payment_status
          );

        const orderTotalCents =
          Number(
            paymentOrder.order_total_cents
          );

        const orderPaidCents =
          Number(
            paymentOrder.order_paid_cents || 0
          );

        const paymentAlreadyRecorded =
          await paymentRecordedEventExists(
            client,
            paymentOrder.order_restaurant_id,
            paymentOrder.order_id,
            paymentIntentId
          );

        const alreadyApplied =
          paymentStatus === 'SUCCEEDED' &&
          Number.isInteger(orderTotalCents) &&
          orderTotalCents > 0 &&
          Number.isInteger(orderPaidCents) &&
          orderPaidCents >= orderTotalCents &&
          paymentAlreadyRecorded;

        if (alreadyApplied) {
          await markWebhookEvent(
            client,
            event.id,
            'processed',
            {
              eventType: event.type,
              paymentIntentId,
              paymentId:
                paymentOrder.payment_id,
              orderId:
                paymentOrder.order_id,
              restaurantId:
                paymentOrder.order_restaurant_id,
              fromStatus:
                paymentStatus,
              toStatus:
                paymentStatus,
              deduplicated: true,
              paymentRecorded: false,
              orderPaid: false,
              orderSent: false,
              statusChangedRecorded: false,
              reason:
                'PAYMENT_ALREADY_APPLIED',
            },
            null
          );

          await client.query('COMMIT');

          return res.status(200).json({
            ok: true,
            deduped: true,
          });
        }

        relationship =
          validatePaymentOrder(
            paymentOrder,
            stripeAmountCents
          );
      }

      let effects;

      if (
        nextStatus === 'SUCCEEDED' &&
        relationship
      ) {
        const reconciliation =
          await reconcileSucceededPayment(
            client,
            paymentIntentId,
            stripeAmountCents,
            event.type
          );

        effects = reconciliation.effects;
      } else {
        const paymentUpdate =
          await updatePaymentStatus(
            client,
            payment,
            nextStatus,
            stripeAmountCents
          );

        effects = {
          eventType: event.type,
          paymentIntentId,
          paymentId: payment.id,
          orderId:
            relationship?.orderId ||
            payment.order_id ||
            null,
          restaurantId:
            relationship?.restaurantId ||
            payment.restaurant_id ||
            null,
          fromStatus:
            payment.status || null,
          toStatus:
            paymentUpdate.status,
          monotonicIgnored:
            !paymentUpdate.updated,
          paymentRecorded: false,
          orderPaid: false,
          orderSent: false,
          statusChangedRecorded: false,
        };
      }

      await markWebhookEvent(
        client,
        event.id,
        'processed',
        effects,
        null
      );

      await client.query('COMMIT');

      return res.status(200).json({
        ok: true,
      });
    } catch (error) {
      const reason =
        getFailureReason(error);

      try {
        await client.query('ROLLBACK');
      } catch {
        req.logEvent?.(
          'error',
          'payment_webhook_failed',
          {
            reason:
              'WEBHOOK_TRANSACTION_ROLLBACK_FAILED',
          }
        );
      }

      const failureRecorded =
        await markWebhookFailure(
          event.id,
          reason
        );

      if (!failureRecorded) {
        req.logEvent?.(
          'error',
          'payment_webhook_failed',
          {
            reason:
              'WEBHOOK_FAILURE_STATUS_PERSISTENCE_FAILED',
          }
        );
      }

      req.logEvent?.(
        'error',
        'payment_webhook_failed',
        {
          reason,
        }
      );

      return res.status(500).json({
        error: 'Webhook processing failed',
      });
    } finally {
      client.release();
    }
  }

  router.post(
    '/webhook',
    express.raw({
      type: 'application/json',
    }),
    handler
  );

  router.get(
    '/webhook/health',
    (_req, res) =>
      res.json({ ok: true })
  );

  return router;
}

module.exports = createPaymentsWebhookRouter;
module.exports.reconcileSucceededPayment =
  reconcileSucceededPayment;
