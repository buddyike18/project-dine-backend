'use strict';

/**
 * orders.lifecycle.js
 *
 * Phase: orders.js restructuring (Phase 4.2 frozen)
 *
 * This module contains order lifecycle (state machine) logic ONLY.
 * It performs transactional, idempotent transitions using row locks.
 */

// Must match Postgres enum: OPEN, SENT, READY, CLOSED, CANCELLED
const ORDER_STATUS = {
  OPEN: 'OPEN',
  SENT: 'SENT',
  READY: 'READY',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
};

// Must match DB transition contract (RECALL: READY -> SENT)
const ALLOWED_TRANSITIONS = {
  [ORDER_STATUS.OPEN]: new Set([ORDER_STATUS.SENT, ORDER_STATUS.CANCELLED]),
  [ORDER_STATUS.SENT]: new Set([ORDER_STATUS.READY, ORDER_STATUS.CANCELLED]),
  [ORDER_STATUS.READY]: new Set([
    ORDER_STATUS.SENT,
    ORDER_STATUS.CLOSED,
    ORDER_STATUS.CANCELLED,
  ]),
  [ORDER_STATUS.CLOSED]: new Set([]),
  [ORDER_STATUS.CANCELLED]: new Set([]),
};

function normalizeRoleForDb(role) {
  const value = String(role || '').trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === 'manager') return 'Manager';
  if (lower === 'employee' || lower === 'staff') return 'Employee';
  if (lower === 'customer') return 'Customer';
  return null;
}

function normalizeRequiredReason(meta, action) {
  const reason =
    meta &&
    typeof meta === 'object' &&
    typeof meta.reason === 'string'
      ? meta.reason.trim()
      : '';

  if (!reason) {
    const err = new Error(`${action} requires a non-empty reason.`);
    err.status = 400;
    throw err;
  }

  return reason;
}

function isManagerRole(role) {
  return role === 'Manager';
}

function requireManagerActor(actor, action) {
  if (!isManagerRole(actor?.role)) {
    const err = new Error(`${action} requires manager privileges.`);
    err.status = 403;
    throw err;
  }
}

function requireTrustedLifecycleContext({ restaurantId, actor }) {
  if (!restaurantId) {
    const err = new Error('restaurantId is required for lifecycle mutations.');
    err.status = 403;
    throw err;
  }

  if (!actor?.userId || !actor?.firebaseUid || !actor?.restaurantId || !actor?.role) {
    const err = new Error('Trusted actor context is required for lifecycle mutations.');
    err.status = 403;
    throw err;
  }

  if (actor.restaurantId !== restaurantId) {
    const err = new Error('Actor is not authorized for this restaurant.');
    err.status = 403;
    throw err;
  }

  if (actor.active !== true) {
    const err = new Error('Inactive actor cannot perform lifecycle mutations.');
    err.status = 403;
    throw err;
  }

  const actorRole = normalizeRoleForDb(actor.role);

  if (!actorRole) {
    const err = new Error(
      'Actor role is not valid for lifecycle mutations.'
    );
    err.status = 403;
    throw err;
  }

  return {
    actor_type: 'USER',
    actor_role: actorRole,
    actor_user_id: actor.userId,
    actor_firebase_uid: actor.firebaseUid,
  };
}

/**
 * Transactional status transition with row lock.
 *
 * @param {import('pg').Pool} pool
 * @param {{orderId: string, restaurantId: string, nextStatus: string, actor: {userId: string, firebaseUid: string, restaurantId: string, role: string, active?: boolean}, meta?: any}} args
 */
async function transitionOrderStatus(
  pool,
  { orderId, restaurantId, nextStatus, actor, meta = null }
) {
  const auditActor = requireTrustedLifecycleContext({ restaurantId, actor });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row-level lock to prevent concurrent transitions (double-taps / multi-device races)
    const cur = await client.query(
      'SELECT id, restaurant_id, status, sent_at, ready_at, closed_at, recalled_at FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [orderId, restaurantId]
    );

    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }

    const previous_state = cur.rows[0].status;

    // Idempotent retry (no side effects)
    if (nextStatus === previous_state) {
      await client.query('COMMIT');
      return {
        order_id: orderId,
        previous_state,
        current_state: previous_state,
        is_noop: true,
        sent_at: cur.rows[0].sent_at,
        ready_at: cur.rows[0].ready_at,
        closed_at: cur.rows[0].closed_at,
        recalled_at: cur.rows[0].recalled_at,
      };
    }

    const allowed = ALLOWED_TRANSITIONS[previous_state];
    if (!allowed || !allowed.has(nextStatus)) {
      await client.query('ROLLBACK');
      return {
        invalidTransition: true,
        order_id: orderId,
        previous_state,
        requested_state: nextStatus,
      };
    }

    const isRecall =
      previous_state === ORDER_STATUS.READY &&
      nextStatus === ORDER_STATUS.SENT;

    let privilegedReason = null;

    if (nextStatus === ORDER_STATUS.CANCELLED) {
      requireManagerActor(actor, 'Cancel order');
      privilegedReason = normalizeRequiredReason(meta, 'Cancel order');
    }

    if (isRecall) {
      requireManagerActor(actor, 'Recall order');
      privilegedReason = normalizeRequiredReason(meta, 'Recall order');
    }

    let sql = 'UPDATE orders SET status = $1';

    // Maintain operational timestamps deterministically (only set once)
    if (previous_state === ORDER_STATUS.OPEN && nextStatus === ORDER_STATUS.SENT) {
      sql += ', sent_at = COALESCE(sent_at, NOW())';
    }

    if (previous_state === ORDER_STATUS.SENT && nextStatus === ORDER_STATUS.READY) {
      sql += ', ready_at = COALESCE(ready_at, NOW())';
    }

    if (previous_state === ORDER_STATUS.READY && nextStatus === ORDER_STATUS.CLOSED) {
      sql += ', closed_at = COALESCE(closed_at, NOW())';
    }

    // RECALL: READY -> SENT
    if (isRecall) {
      sql += ', recalled_at = NOW(), ready_at = NULL';
    }

    sql += ' WHERE id = $2 AND restaurant_id = $3 RETURNING id, restaurant_id, status, sent_at, ready_at, closed_at, recalled_at';

    const upd = await client.query(sql, [nextStatus, orderId, restaurantId]);

    // Emit an immutable audit event for deterministic replay/debugging.
    // NOTE: This is intentionally inside the same transaction as the status transition.
    const event_type =
      nextStatus === ORDER_STATUS.CANCELLED
        ? 'ORDER_VOIDED'
        : isRecall
          ? 'RECALL'
          : 'STATUS_CHANGED';

    const meta_payload = privilegedReason
      ? {
          reason: privilegedReason,
          ...(event_type === 'ORDER_VOIDED'
            ? { actor_role: auditActor.actor_role }
            : {}),
        }
      : meta && typeof meta === 'object'
        ? {
            ...meta,
            ...(event_type === 'ORDER_VOIDED'
              ? { actor_role: auditActor.actor_role }
              : {}),
          }
        : meta !== null && meta !== undefined
          ? {
              value: meta,
              ...(event_type === 'ORDER_VOIDED'
                ? { actor_role: auditActor.actor_role }
                : {}),
            }
          : event_type === 'ORDER_VOIDED'
            ? { actor_role: auditActor.actor_role }
            : null;

    try {
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
           meta,
           created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          upd.rows[0].id,
          upd.rows[0].restaurant_id,
          event_type,
          previous_state,
          nextStatus,
          auditActor.actor_type,
          auditActor.actor_role,
          auditActor.actor_user_id,
          auditActor.actor_firebase_uid,
          meta_payload,
        ]
      );
    } catch (e) {
      // If the order_events table/migration hasn't been applied, fail loudly with a clear message.
      // (Do not silently drop audit events.)
      if (e && e.code === '42P01') {
        const err = new Error(
          'order_events table is missing. Apply migration 002_order_events.sql before using status transitions.'
        );
        err.code = 'ORDER_EVENTS_MISSING';
        throw err;
      }
      throw e;
    }

    await client.query('COMMIT');
    return {
      order_id: upd.rows[0].id,
      previous_state,
      current_state: upd.rows[0].status,
      is_noop: false,
      sent_at: upd.rows[0].sent_at,
      ready_at: upd.rows[0].ready_at,
      closed_at: upd.rows[0].closed_at,
      recalled_at: upd.rows[0].recalled_at,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {}
    throw err;
  } finally {
    client.release();
  }
}


/**
 * Transactional manager comp helper with row lock.
 *
 * @param {import('pg').Pool} pool
 * @param {{orderId: string, restaurantId: string, actor: {userId: string, firebaseUid: string, restaurantId: string, role: string, active?: boolean}, meta?: any}} args
 */
async function overrideOrderStatus(pool, {
  orderId,
  restaurantId,
  nextStatus,
  actor,
  meta = null,
}) {
  const auditActor = requireTrustedLifecycleContext({ restaurantId, actor });
  requireManagerActor(actor, 'Override order status');
  const reason = normalizeRequiredReason(meta, 'Override order status');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT id, restaurant_id, status
       FROM orders
       WHERE id = $1
         AND restaurant_id = $2
       FOR UPDATE`,
      [orderId, restaurantId]
    );

    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }

    const order = cur.rows[0];
    const previousState = String(order.status || '').toUpperCase();

    if (previousState === nextStatus) {
      await client.query('COMMIT');

      return {
        order_id: order.id,
        previous_state: previousState,
        current_state: previousState,
        is_noop: true,
      };
    }

    const upd = await client.query(
      `UPDATE orders
       SET status = $1,
           sent_at = CASE
             WHEN $1 = 'SENT'
               THEN COALESCE(sent_at, NOW())
             ELSE sent_at
           END,
           ready_at = CASE
             WHEN $1 = 'READY'
               THEN COALESCE(ready_at, NOW())
             WHEN $1 = 'SENT' AND $2 = 'READY'
               THEN NULL
             ELSE ready_at
           END,
           recalled_at = CASE
             WHEN $1 = 'SENT' AND $2 = 'READY'
               THEN NOW()
             ELSE recalled_at
           END,
           closed_at = CASE
             WHEN $1 IN ('CLOSED', 'CANCELLED')
               THEN COALESCE(closed_at, NOW())
             ELSE closed_at
           END
       WHERE id = $3
         AND restaurant_id = $4
       RETURNING
         id,
         restaurant_id,
         status,
         sent_at,
         ready_at,
         recalled_at,
         closed_at`,
      [nextStatus, previousState, orderId, restaurantId]
    );

    await client.query(
      `INSERT INTO order_events (
         order_id,
         restaurant_id,
         actor_type,
         actor_user_id,
         actor_firebase_uid,
         actor_role,
         event_type,
         from_status,
         to_status,
         meta
       ) VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         'ORDER_OVERRIDE',
         $7,
         $8,
         $9::jsonb
       )`,
      [
        order.id,
        order.restaurant_id,
        auditActor.actor_type,
        auditActor.actor_user_id,
        auditActor.actor_firebase_uid,
        auditActor.actor_role,
        previousState,
        nextStatus,
        JSON.stringify({ reason }),
      ]
    );

    await client.query('COMMIT');

    return {
      order_id: upd.rows[0].id,
      previous_state: previousState,
      current_state: upd.rows[0].status,
      is_noop: false,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Preserve the original failure.
    }

    throw err;
  } finally {
    client.release();
  }
}

async function compOrder(
  pool,
  { orderId, restaurantId, actor, meta = null }
) {
  const auditActor = requireTrustedLifecycleContext({ restaurantId, actor });
  requireManagerActor(actor, 'Comp order');
  const reason = normalizeRequiredReason(meta, 'Comp order');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT id, restaurant_id, status, total_cents, paid_cents, comped_cents
       FROM orders
       WHERE id = $1 AND restaurant_id = $2
       FOR UPDATE`,
      [orderId, restaurantId]
    );

    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }

    const order = cur.rows[0];

    if (order.status === ORDER_STATUS.CANCELLED) {
      await client.query('ROLLBACK');
      return {
        invalidState: true,
        order_id: orderId,
        current_state: order.status,
      };
    }

    const totalCents = Number(order.total_cents || 0);
    const paidCents = Number(order.paid_cents || 0);
    const compedCents = Number(order.comped_cents || 0);
    const remainingCompCents =
      totalCents - paidCents - compedCents;

    if (remainingCompCents <= 0) {
      await client.query('COMMIT');
      return {
        order_id: order.id,
        current_state: order.status,
        paid_cents: paidCents,
        comped_cents: compedCents,
        total_cents: totalCents,
        is_noop: true,
      };
    }

    const upd = await client.query(
      `UPDATE orders
       SET comped_cents = comped_cents + $3
       WHERE id = $1 AND restaurant_id = $2
       RETURNING
         id,
         restaurant_id,
         status,
         total_cents,
         paid_cents,
         comped_cents`,
      [orderId, restaurantId, remainingCompCents]
    );

    const meta_payload = {
      reason,
      comped_cents: remainingCompCents,
      actor_role: auditActor.actor_role,
    };

    try {
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
           meta,
           created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          upd.rows[0].id,
          upd.rows[0].restaurant_id,
          'ORDER_COMPED',
          null,
          null,
          auditActor.actor_type,
          auditActor.actor_role,
          auditActor.actor_user_id,
          auditActor.actor_firebase_uid,
          meta_payload,
        ]
      );
    } catch (e) {
      if (e && e.code === '42P01') {
        const err = new Error(
          'order_events table is missing. Apply migration 002_order_events.sql before using comp overrides.'
        );
        err.code = 'ORDER_EVENTS_MISSING';
        throw err;
      }
      throw e;
    }

    await client.query('COMMIT');
    return {
      order_id: upd.rows[0].id,
      current_state: upd.rows[0].status,
      paid_cents: Number(upd.rows[0].paid_cents || 0),
      comped_cents: Number(upd.rows[0].comped_cents || 0),
      total_cents: Number(upd.rows[0].total_cents || 0),
      is_noop: false,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ORDER_STATUS,
  ALLOWED_TRANSITIONS,
  normalizeRequiredReason,
  isManagerRole,
  requireManagerActor,
  requireTrustedLifecycleContext,
  transitionOrderStatus,
  overrideOrderStatus,
  compOrder,
};