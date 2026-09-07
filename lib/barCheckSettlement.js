'use strict';

async function settleBarCheckPayment({
  client,
  restaurantId,
  checkId,
  paymentMethod,
  actor,
  actorType = 'STAFF',
  paymentId = null,
  paymentIntentId = null,
  provider = null,
  expectedAmountCents = null,
}) {
  const checkResult = await client.query(
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
    [checkId, restaurantId]
  );

  if (checkResult.rows.length === 0) {
    const error = new Error('Bar check not found.');
    error.status = 404;
    error.statusCode = 404;
    throw error;
  }

  const check = checkResult.rows[0];

  if (check.status !== 'OPEN') {
    const error = new Error('Bar check is not open.');
    error.status = 409;
    error.statusCode = 409;
    throw error;
  }

  const ordersResult = await client.query(
    `SELECT
       id,
       restaurant_id,
       status,
       total_cents,
       paid_cents,
       comped_cents
     FROM orders
     WHERE restaurant_id = $1
       AND check_id = $2
       AND status <> 'CANCELLED'
     ORDER BY opened_at ASC, id ASC
     FOR UPDATE`,
    [restaurantId, checkId]
  );

  const orders = ordersResult.rows;

  const settlementPlan = orders.map((order) => {
    const totalCents = Number(order.total_cents || 0);
    const paidCents = Number(order.paid_cents || 0);
    const compedCents = Number(order.comped_cents || 0);

    const remainingCents = Math.max(
      totalCents - paidCents - compedCents,
      0
    );

    return {
      order,
      totalCents,
      paidCents,
      compedCents,
      remainingCents,
    };
  });

  const amountPaidCents = settlementPlan.reduce(
    (sum, entry) => sum + entry.remainingCents,
    0
  );

  if (
    expectedAmountCents !== null &&
    amountPaidCents > 0 &&
    (
      !Number.isInteger(Number(expectedAmountCents)) ||
      Number(expectedAmountCents) !== amountPaidCents
    )
  ) {
    const error = new Error(
      'CHECK_PAYMENT_AMOUNT_MISMATCH'
    );
    error.reason = 'CHECK_PAYMENT_AMOUNT_MISMATCH';
    throw error;
  }

  if (amountPaidCents === 0) {
    const noopTotalCents = settlementPlan.reduce(
      (sum, entry) => sum + entry.totalCents,
      0
    );
    const noopPaidCents = settlementPlan.reduce(
      (sum, entry) => sum + entry.paidCents,
      0
    );
    const noopCompedCents = settlementPlan.reduce(
      (sum, entry) => sum + entry.compedCents,
      0
    );
    const noopAmountOwedCents = Math.max(
      noopTotalCents - noopPaidCents - noopCompedCents,
      0
    );

    let noopPaymentState = 'UNPAID';

    if (settlementPlan.length === 0) {
      noopPaymentState = 'UNPAID';
    } else if (
      noopAmountOwedCents === 0 &&
      noopPaidCents > 0
    ) {
      noopPaymentState = 'PAID';
    } else if (
      noopAmountOwedCents === 0 &&
      noopPaidCents === 0 &&
      noopCompedCents > 0
    ) {
      noopPaymentState = 'COMPED';
    } else if (
      noopPaidCents > 0 ||
      noopCompedCents > 0
    ) {
      noopPaymentState = 'PARTIAL';
    }

    return {
      amount_paid_cents: 0,
      payment_state: noopPaymentState,
      amount_owed_cents: noopAmountOwedCents,
      orders_settled: 0,
      is_noop: true,
    };
  }

  let ordersSettled = 0;

  for (const entry of settlementPlan) {
    if (entry.remainingCents <= 0) {
      continue;
    }

    if (paymentId) {
      const allocationResult =
        await client.query(
          `INSERT INTO payment_order_allocations (
             payment_id,
             order_id,
             amount_cents
           )
           VALUES ($1, $2, $3)
           ON CONFLICT (
             payment_id,
             order_id
           )
           DO NOTHING
           RETURNING id`,
          [
            paymentId,
            entry.order.id,
            entry.remainingCents,
          ]
        );

      // A provider retry for an allocation already applied must
      // not increment paid_cents or recreate lifecycle events.
      if (allocationResult.rowCount === 0) {
        continue;
      }
    }

    const updatedResult = await client.query(
      `UPDATE orders
       SET paid_cents = paid_cents + $1
       WHERE id = $2
         AND restaurant_id = $3
       RETURNING
         id,
         restaurant_id,
         status,
         total_cents,
         paid_cents,
         comped_cents`,
      [
        entry.remainingCents,
        entry.order.id,
        restaurantId,
      ]
    );

    let updatedOrder = updatedResult.rows[0];

    const paymentMeta = {
      amount_cents: entry.remainingCents,
      payment_method: paymentMethod,
      check_id: checkId,
    };

    if (paymentId) {
      paymentMeta.payment_id = paymentId;
    }

    if (paymentIntentId) {
      paymentMeta.payment_intent_id =
        paymentIntentId;
      paymentMeta.payment_reference =
        paymentIntentId;
    }

    if (provider) {
      paymentMeta.provider = provider;
    }

    await client.query(
      `INSERT INTO order_events (
         order_id,
         restaurant_id,
         event_type,
         from_status,
         to_status,
         actor_type,
         actor_role,
         actor_user_id,
         actor_firebase_uid,
         idempotency_key,
         meta,
         created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
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
       DO NOTHING`,
      [
        updatedOrder.id,
        updatedOrder.restaurant_id,
        'PAYMENT_RECORDED',
        null,
        null,
        actorType,
        actorType === 'PAYMENT_PROVIDER'
          ? null
          : actor?.role || null,
        actorType === 'PAYMENT_PROVIDER'
          ? null
          : actor?.userId || null,
        actorType === 'PAYMENT_PROVIDER'
          ? null
          : actor?.firebaseUid || null,
        actorType === 'PAYMENT_PROVIDER' &&
        paymentIntentId
          ? `stripe-payment:${paymentIntentId}:order:${updatedOrder.id}`
          : null,
        JSON.stringify(paymentMeta),
      ]
    );

    const isFullySettled =
      Number(updatedOrder.paid_cents || 0) +
        Number(updatedOrder.comped_cents || 0) >=
      Number(updatedOrder.total_cents || 0);

    if (
      updatedOrder.status === 'OPEN' &&
      isFullySettled
    ) {
      const sentResult = await client.query(
        `UPDATE orders
         SET status = 'SENT',
             sent_at = COALESCE(sent_at, NOW())
         WHERE id = $1
           AND restaurant_id = $2
         RETURNING
           id,
           restaurant_id,
           status,
           total_cents,
           paid_cents,
           comped_cents`,
        [
          updatedOrder.id,
          updatedOrder.restaurant_id,
        ]
      );

      updatedOrder = sentResult.rows[0];

      const statusMeta = {
        check_id: checkId,
        reason: 'PAYMENT_SETTLED',
      };

      if (paymentId) {
        statusMeta.payment_id = paymentId;
      }

      if (paymentIntentId) {
        statusMeta.payment_intent_id =
          paymentIntentId;
        statusMeta.payment_reference =
          paymentIntentId;
      }

      if (provider) {
        statusMeta.provider = provider;
      }

      await client.query(
        `INSERT INTO order_events (
           order_id,
           restaurant_id,
           event_type,
           from_status,
           to_status,
           actor_type,
           actor_role,
           actor_user_id,
           actor_firebase_uid,
           idempotency_key,
           meta,
           created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
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
         WHERE idempotency_key IS NOT NULL
         DO NOTHING`,
        [
          updatedOrder.id,
          updatedOrder.restaurant_id,
          'STATUS_CHANGED',
          'OPEN',
          'SENT',
          actorType,
          actorType === 'PAYMENT_PROVIDER'
            ? null
            : actor?.role || null,
          actorType === 'PAYMENT_PROVIDER'
            ? null
            : actor?.userId || null,
          actorType === 'PAYMENT_PROVIDER'
            ? null
            : actor?.firebaseUid || null,
          actorType === 'PAYMENT_PROVIDER' &&
        paymentIntentId
          ? `stripe-payment:${paymentIntentId}:sent:${updatedOrder.id}`
          : null,
        JSON.stringify(statusMeta),
      ]
    );
    }

    ordersSettled += 1;
  }

  const summaryResult = await client.query(
    `SELECT
       COALESCE(COUNT(*), 0)::int AS order_count,
       COALESCE(SUM(total_cents), 0)::bigint AS total_cents,
       COALESCE(SUM(paid_cents), 0)::bigint AS paid_cents,
       COALESCE(SUM(comped_cents), 0)::bigint AS comped_cents
     FROM orders
     WHERE restaurant_id = $1
       AND check_id = $2
       AND status <> 'CANCELLED'`,
    [restaurantId, checkId]
  );

  const summary = summaryResult.rows[0];

  const totalCents = Number(summary.total_cents || 0);
  const paidCents = Number(summary.paid_cents || 0);
  const compedCents = Number(summary.comped_cents || 0);

  const amountOwedCents = Math.max(
    totalCents - paidCents - compedCents,
    0
  );

  let paymentState = 'UNPAID';

  if (Number(summary.order_count || 0) === 0) {
    paymentState = 'UNPAID';
  } else if (amountOwedCents === 0 && paidCents > 0) {
    paymentState = 'PAID';
  } else if (
    amountOwedCents === 0 &&
    paidCents === 0 &&
    compedCents > 0
  ) {
    paymentState = 'COMPED';
  } else if (paidCents > 0 || compedCents > 0) {
    paymentState = 'PARTIAL';
  }

  return {
    amount_paid_cents: amountPaidCents,
    payment_state: paymentState,
    amount_owed_cents: amountOwedCents,
    orders_settled: ordersSettled,
    is_noop: false,
  };
}

module.exports = {
  settleBarCheckPayment,
};
