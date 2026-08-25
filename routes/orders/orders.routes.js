'use strict';

const express = require('express');
const { resolveActor } = require('../../middleware/resolveActor');
const config = require('../../config');

module.exports = function buildOrdersRouter({ pool, verifyToken, handleError }) {
  const router = express.Router();


  // Must match Postgres enum: OPEN, SENT, READY, CLOSED, CANCELLED
  const allowedStatus = ['OPEN', 'SENT', 'READY', 'CLOSED', 'CANCELLED'];
  const allowedPriority = ['Low', 'Medium', 'High', 'Urgent'];
  const allowedPaymentMethod = ['cash', 'card'];

  const OrdersQ = require('./orders.queries');
  const OrdersLifecycle = require('./orders.lifecycle');

  const isUuid = (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

  // Phase 9.1.B — Idempotency helpers
  const getIdempotencyKey = (req) =>
    String(req.get('Idempotency-Key') || req.get('idempotency-key') || '').trim();

  const isValidIdempotencyKey = (value) =>
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[\x21-\x7E]+$/.test(value);

  const isProd = String(config.app.nodeEnv || '').toLowerCase() === 'production';

  const stableItemHashPayload = (restaurantId, tableId, items) => {
    const norm = (items || []).map((it) => {
      const modifiers = Array.isArray(it.modifiers)
        ? it.modifiers.map((group) => ({
            group_id: group.group_id,
            option_ids: Array.isArray(group.option_ids)
              ? [...group.option_ids].sort()
              : [],
          }))
        : [];

      modifiers.sort((a, b) =>
        String(a.group_id || '').localeCompare(String(b.group_id || ''))
      );

      return {
        menu_item_id: it.menu_item_id,
        quantity: it.quantity,
        modifiers,
      };
    });

    norm.sort((a, b) => {
      const ak = `${a.menu_item_id}|${JSON.stringify(a.modifiers)}`;
      const bk = `${b.menu_item_id}|${JSON.stringify(b.modifiers)}`;
      if (ak < bk) return -1;
      if (ak > bk) return 1;
      return a.quantity - b.quantity;
    });

    return JSON.stringify({
      restaurantId,
      tableId: tableId || null,
      items: norm,
    });
  };

  // Phase 7.1 — Role scope helpers (route-level)
  const MANAGER_SCOPE = new Set(['manager']);
  const isManagerScope = (role) => MANAGER_SCOPE.has(String(role || '').toLowerCase());

  const OPERATIONAL_SCOPE = new Set(['manager', 'employee']);
  const isOperationalScope = (role) => OPERATIONAL_SCOPE.has(String(role || '').toLowerCase());

  const employeeHasActiveTableAssignment = async ({
    restaurantId,
    tableId,
    userId,
  }) => {
    if (!restaurantId || !tableId || !userId) return false;

    const result = await pool.query(
      `SELECT 1
       FROM table_assignments
       WHERE restaurant_id = $1
         AND table_id = $2
         AND staff_user_id = $3
         AND active = true
       LIMIT 1`,
      [restaurantId, tableId, userId]
    );

    return result.rowCount > 0;
  };

  const normalizeRoleForDb = (rawRole) => {
    const r = String(rawRole || '').trim().toLowerCase();
    if (r === 'manager') return 'Manager';
    if (r === 'employee' || r === 'staff') return 'Employee';
    if (r === 'customer') return 'Customer';
    return null;
  };



  // Phase 7.1 — Resolve backend user UUID + restaurant scope from Firebase uid.
  // Visibility must be enforced by backend queries, not client filtering.
  const resolveActorContext = async (req) => {
    try {
      const actor = await resolveActor(pool, req);

      if (!actor?.userId || !actor?.restaurantId) {
        const e = new Error('User missing restaurant scope');
        e.status = 403;
        throw e;
      }

      return actor;
    } catch (err) {
      if (Number.isInteger(err?.statusCode) && !Number.isInteger(err?.status)) {
        err.status = err.statusCode;
      }
      throw err;
    }
  };

  // Phase 7.1 — Manager-only guard helper
  const requireManagerScope = async (req, res) => {
    const ctx = await resolveActorContext(req);
    if (!isManagerScope(ctx.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return ctx;
  };

  // Phase 17 — KDS is a restaurant-scoped operational surface.
  // Any authenticated, provisioned user with a resolved restaurant scope may load KDS.
  const requireKitchenScope = async (req, res) => {
    const ctx = await resolveActorContext(req);

    if (!ctx?.restaurantId || !isOperationalScope(ctx.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return ctx;
  };

  // Phase 7.1 — Enforce per-order visibility for non-manager scope.
  const assertOrderVisible = (order, ctx) => {
    if (!order) return false;
    if (isManagerScope(ctx.role)) return true;
    return order.created_by_user_id === ctx.userId;
  };

  const validate = (rules) => (req, res, next) => {
    for (const [field, check] of Object.entries(rules)) {
      if (!check(req.body[field])) {
        return res.status(400).json({ error: `Invalid or missing '${field}'` });
      }
    }
    next();
  };

  // Phase 9.5B — Normalize DB outage errors to 503 for this router (route-level handling)
  const isDbUnavailableErr = (err) => {
    if (!err) return false;
    // Node may wrap dual-stack connection failures in AggregateError with inner errors[]
    if (Array.isArray(err.errors) && err.errors.length) {
      return err.errors.some((e) => isDbUnavailableErr(e));
    }
    const code = String(err.code || '').toUpperCase();
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'EPIPE' ||
      code === 'ECONNRESET' ||
      code === 'ECONNABORTED' ||
      code === '57P01' || // admin_shutdown
      code === '57P02' || // crash_shutdown
      code === '57P03' || // cannot_connect_now
      code === '53300' || // too_many_connections
      code === '53400'    // configuration_limit_exceeded
    ) return true;

    // Handle wrapped errors
    if (err.cause) return isDbUnavailableErr(err.cause);

    return false;
  };

  const handleErrorWithStatus = (res, err) => {
    if (isDbUnavailableErr(err)) {
      return res.status(503).json({
        error: 'Service unavailable',
        code: 'DB_UNAVAILABLE',
      });
    }

    if (err && Number.isInteger(err.status)) {
      const status = [400, 401, 403, 404, 409].includes(err.status)
        ? err.status
        : 500;

      const messageByStatus = {
        400: 'Invalid request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not found',
        409: 'Request conflict',
        500: 'Internal server error',
      };

      return res.status(status).json({
        error: messageByStatus[status],
      });
    }

    return handleError(res, err);
  };



  // List orders (current behavior: history)
  router.get('/', verifyToken, async (req, res) => {
    try {
      const ctx = await resolveActorContext(req);
      const rows = await OrdersQ.listHistoryScoped(pool, ctx);
      res.json({ orders: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Create order (customer checkout)
  router.post(
    '/',
    validate({
      // Accept either restaurant_id (preferred) or restaurantId (client)
      restaurant_id: (v) => v === undefined || isUuid(v),
      restaurantId: (v) => v === undefined || isUuid(v),
      table_id: (v) =>
        v === undefined ||
        v === null ||
        (typeof v === 'string' && v.trim().length > 0) ||
        Number.isInteger(v),
      items: (v) =>
        Array.isArray(v) &&
        v.length > 0 &&
        v.every(
          (it) =>
            it &&
            isUuid(it.menu_item_id) &&
            Number.isInteger(it.quantity) &&
            it.quantity > 0 &&
            (it.modifiers === undefined ||
              (Array.isArray(it.modifiers) &&
                it.modifiers.every(
                  (group) =>
                    group &&
                    isUuid(group.group_id) &&
                    Array.isArray(group.option_ids) &&
                    group.option_ids.every((optionId) => isUuid(optionId))
                )))
        ),
      // Accept either total_cents (preferred) or total_price (legacy dollars)
      total_cents: (v) => v === undefined || (Number.isInteger(v) && v >= 0),
      total_price: (v) => v === undefined || (typeof v === 'number' && v >= 0),
    }),
    verifyToken,
    async (req, res, next) => {
      let client = null;

      try {
        client = await pool.connect();
      } catch (err) {
        req.logEvent?.('error', {
          at: 'orders.routes',
          event: 'order.database_connection_failed',
          requestId: req.requestId || null,
          failureType: isDbUnavailableErr(err)
            ? 'database_unavailable'
            : 'database_connection_failed',
        });

        return handleErrorWithStatus(res, err);
      }

      const q = async (step, text, params) => {
        try {
          return await client.query(text, params);
        } catch (err) {
          req.logEvent?.('error', {
            at: 'orders.routes',
            event: 'order.transaction_step_failed',
            requestId: req.requestId || null,
            step,
            failureType: isDbUnavailableErr(err)
              ? 'database_unavailable'
              : 'database_operation_failed',
          });
          throw err;
        }
      };

      const restaurant_id = req.body.restaurant_id || req.body.restaurantId;

      const { items } = req.body;

      const idempotencyKey = getIdempotencyKey(req);

      if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
        client?.release();
        return res.status(400).json({
          error: 'Invalid Idempotency-Key header',
        });
      }

      if (isProd && !idempotencyKey) {
        client?.release();
        return res.status(400).json({ error: 'Missing Idempotency-Key header' });
      }

      // Phase 17 — Customer checkout must be restaurant-valid, not staff-scope-bound.
      // Customer actors may be provisioned against the explicitly selected restaurant context
      // because dine-customer selects restaurant at runtime rather than from staff token scope.
      const requestedRestaurantId = isUuid(restaurant_id) ? restaurant_id : null;

      let ctx;
      let isCustomerActor = false;

      if (!req.user?.uid) {
        client?.release();
        return res.status(401).json({ error: 'Unauthorized' });
      }

      let existingActorRow = null;

      try {
        const existingActor = await q(
          'lookup actor user row for create-order classification',
          `SELECT id, role, restaurant_id, active
           FROM users
           WHERE firebase_uid = $1
           LIMIT 1`,
          [req.user.uid]
        );
        existingActorRow = existingActor.rows?.[0] || null;
      } catch (e) {

        client?.release();
        return handleErrorWithStatus(res, e);
      }

      const existingActorRole = String(existingActorRow?.role || '').trim().toLowerCase();



      if (!existingActorRow) {
        if (!isUuid(requestedRestaurantId)) {
          client?.release();
          return res.status(400).json({ error: "Invalid or missing 'restaurant_id'" });
        }

        try {
          await q(
            'insert customer user row for requested restaurant',
            `INSERT INTO users (firebase_uid, role, restaurant_id, active, created_at)
             VALUES ($1, 'Customer', $2, true, NOW())`,
            [req.user.uid, requestedRestaurantId]
          );


        } catch (e) {

          client?.release();
          return handleErrorWithStatus(res, e);
        }
      } else if (existingActorRole === 'customer') {
        if (!isUuid(requestedRestaurantId)) {
          client?.release();
          return res.status(400).json({ error: "Invalid or missing 'restaurant_id'" });
        }

        if (existingActorRow.restaurant_id !== requestedRestaurantId) {
          client?.release();
          return res.status(403).json({ error: 'Forbidden' });
        }
      }

      try {
        ctx = await resolveActorContext(req);

      } catch (e) {

        client?.release();
        return handleErrorWithStatus(res, e);
      }

      isCustomerActor = String(ctx.role || '').trim().toLowerCase() === 'customer';

      const orderOrigin = isCustomerActor ? 'CUSTOMER' : 'STAFF';
      const actorRoleForDb = normalizeRoleForDb(ctx.role);
      const actorTypeForDb = isCustomerActor ? 'CUSTOMER' : 'USER';
      const createdByUserIdForOrder = ctx.userId;
      const actorUserIdForDb = isCustomerActor ? null : ctx.userId;
      const actorFirebaseUidForDb = isCustomerActor ? req.user.uid : null;

      if (!actorRoleForDb) {
        client?.release();
        return res.status(403).json({ error: 'Forbidden' });
      }

      let restaurantIdFinal = null;

      if (isCustomerActor) {
        restaurantIdFinal = requestedRestaurantId;
      } else {

        const scopedRestaurantId = ctx.restaurantId;
        if (requestedRestaurantId && requestedRestaurantId !== scopedRestaurantId) {

          client?.release();
          return res.status(403).json({ error: 'Forbidden' });
        }
        restaurantIdFinal = scopedRestaurantId;
      }

      if (!isUuid(restaurantIdFinal)) {
        client?.release();
        return res.status(400).json({ error: "Invalid or missing 'restaurant_id'" });
      }

      const tableIdRaw = req.body?.table_id;
      const tableId =
        tableIdRaw === undefined || tableIdRaw === null
          ? null
          : String(tableIdRaw).trim().length > 0
            ? String(tableIdRaw).trim()
            : null;

      try {
        await q('BEGIN', 'BEGIN');

        // Phase 40K — Transactional order-creation idempotency.
        if (idempotencyKey) {
          const signature = stableItemHashPayload(
            restaurantIdFinal,
            tableId,
            items
          );

          const actorScope = actorUserIdForDb
            ? `user:${actorUserIdForDb}`
            : actorFirebaseUidForDb
              ? `firebase:${actorFirebaseUidForDb}`
              : null;

          if (!actorScope) {
            throw new Error(
              'ORDER_IDEMPOTENCY_ACTOR_REQUIRED'
            );
          }

          await q(
            'lock order idempotency scope',
            `SELECT pg_advisory_xact_lock(
               hashtextextended($1, 0)
             )`,
            [
              [
                'ORDER_CREATED',
                restaurantIdFinal,
                actorScope,
                idempotencyKey,
              ].join(':'),
            ]
          );

          const existingEventResult = await q(
            'idempotency lookup',
            `SELECT
               e.order_id,
               e.meta->>'signature' AS signature
             FROM order_events e
             WHERE e.event_type = 'ORDER_CREATED'
               AND e.restaurant_id = $1
               AND e.idempotency_key = $2
               AND CASE
                 WHEN e.actor_user_id IS NOT NULL
                   THEN 'user:' || e.actor_user_id::text
                 WHEN e.actor_firebase_uid IS NOT NULL
                   THEN 'firebase:' || e.actor_firebase_uid
                 ELSE NULL
               END = $3
             LIMIT 2`,
            [
              restaurantIdFinal,
              idempotencyKey,
              actorScope,
            ]
          );

          if (existingEventResult.rows.length > 1) {
            throw new Error(
              'ORDER_IDEMPOTENCY_STATE_INVALID'
            );
          }

          if (existingEventResult.rows.length === 1) {
            const existingEvent = existingEventResult.rows[0];

            if (existingEvent.signature !== signature) {
              await q('ROLLBACK', 'ROLLBACK');

              return res.status(409).json({
                error:
                  'Idempotency key cannot be reused for a different request.',
              });
            }

            const existingOrderResult = await q(
              'idempotency hydrate order',
              `SELECT *
               FROM orders
               WHERE id = $1
                 AND restaurant_id = $2
               LIMIT 1`,
              [
                existingEvent.order_id,
                restaurantIdFinal,
              ]
            );

            if (existingOrderResult.rows.length !== 1) {
              throw new Error(
                'ORDER_IDEMPOTENCY_STATE_INVALID'
              );
            }

            await q('COMMIT', 'COMMIT');

            return res.status(200).json({
              order: existingOrderResult.rows[0],
            });
          }
        }

        const normalizedItems = [];

        for (const item of items) {
          const menuItemId = item.menu_item_id;

          const menuItemResult = await q(
            'hydrate canonical menu item',
            `SELECT mi.id,
                    mi.name,
                    mi.price_cents
             FROM menu_items mi
             LEFT JOIN menu_categories mc
               ON mc.id = mi.category_id
              AND mc.active = true
             WHERE mi.id = $1
               AND mi.restaurant_id = $2
               AND mi.active = true
               AND mi.available = true
               AND (
                 mi.category_id IS NULL
                 OR mc.id IS NOT NULL
               )
             LIMIT 1`,
            [menuItemId, restaurantIdFinal]
          );

          const menuItemRow = menuItemResult.rows?.[0];

          if (!menuItemRow) {
            const err = new Error('Menu item is unavailable or invalid');
            err.status = 400;
            throw err;
          }

          const linkedGroupsResult = await q(
            'load linked modifier groups',
            `SELECT mg.id,
                    mg.name,
                    mg.min_select,
                    mg.max_select
             FROM menu_item_modifier_groups mimg
             JOIN modifier_groups mg
               ON mg.id = mimg.group_id
             WHERE mimg.menu_item_id = $1
               AND mg.restaurant_id = $2
               AND mg.active = true
             ORDER BY COALESCE(mimg.sort_order, mg.sort_order) ASC,
                      mg.name ASC`,
            [menuItemId, restaurantIdFinal]
          );

          const linkedGroups = linkedGroupsResult.rows || [];
          const linkedGroupMap = new Map(
            linkedGroups.map((group) => [group.id, group])
          );

          const submittedGroups = Array.isArray(item.modifiers)
            ? item.modifiers
            : [];

          const submittedGroupMap = new Map();

          for (const submittedGroup of submittedGroups) {
            if (submittedGroupMap.has(submittedGroup.group_id)) {
              const err = new Error('Duplicate modifier group selection');
              err.status = 400;
              throw err;
            }

            submittedGroupMap.set(submittedGroup.group_id, submittedGroup);

            if (!linkedGroupMap.has(submittedGroup.group_id)) {
              const err = new Error('Invalid modifier group for menu item');
              err.status = 400;
              throw err;
            }
          }

          const normalizedModifiers = [];
          let modifierTotalCents = 0;

          for (const linkedGroup of linkedGroups) {
            const submittedGroup = submittedGroupMap.get(linkedGroup.id);
            const optionIds = submittedGroup?.option_ids || [];
            const selectionCount = optionIds.length;

            if (
              selectionCount < linkedGroup.min_select ||
              selectionCount > linkedGroup.max_select
            ) {
              const err = new Error('Invalid modifier selection count');
              err.status = 400;
              throw err;
            }

            const uniqueOptionIds = new Set(optionIds);

            if (uniqueOptionIds.size !== optionIds.length) {
              const err = new Error('Duplicate modifier option selection');
              err.status = 400;
              throw err;
            }

            if (optionIds.length === 0) {
              continue;
            }

            const optionsResult = await q(
              'load canonical modifier options',
              `SELECT id,
                      group_id,
                      name,
                      price_delta_cents
               FROM modifier_options
               WHERE group_id = $1
                 AND active = true
                 AND id = ANY($2::uuid[])
               ORDER BY id ASC`,
              [linkedGroup.id, optionIds]
            );

            const optionRows = optionsResult.rows || [];

            if (optionRows.length !== optionIds.length) {
              const err = new Error('Invalid modifier option for group');
              err.status = 400;
              throw err;
            }

            for (const optionRow of optionRows) {
              modifierTotalCents += optionRow.price_delta_cents;

              normalizedModifiers.push({
                group_id: linkedGroup.id,
                option_id: optionRow.id,
                group_name_snapshot: linkedGroup.name,
                option_name_snapshot: optionRow.name,
                price_delta_cents_snapshot: optionRow.price_delta_cents,
                quantity: 1,
              });
            }
          }

          normalizedItems.push({
            menu_item_id: menuItemRow.id,
            name_snapshot: menuItemRow.name,
            unit_price_cents_snapshot: menuItemRow.price_cents,
            quantity: item.quantity,
            modifier_total_cents: modifierTotalCents,
            modifiers: normalizedModifiers,
          });
        }

        const subtotal_cents = normalizedItems.reduce(
          (sum, it) =>
            sum +
            (it.unit_price_cents_snapshot + it.modifier_total_cents) *
              it.quantity,
          0
        );
        const tax_cents = 0;
        const tip_cents = 0;
        const total_cents = subtotal_cents + tax_cents + tip_cents;
        const paid_cents = 0;

        const orderResult = await q(
          'insert orders',
          `INSERT INTO orders (
             restaurant_id,
             table_id,
             created_by_user_id,
             order_origin,
             subtotal_cents,
             tax_cents,
             tip_cents,
             total_cents,
             paid_cents,
             status,
             opened_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', NOW())
           RETURNING *`,
          [
            restaurantIdFinal,
            tableId,
            createdByUserIdForOrder,
            orderOrigin,
            subtotal_cents,
            tax_cents,
            tip_cents,
            total_cents,
            paid_cents,
          ]
        );

        const order = orderResult.rows[0];

        for (const it of normalizedItems) {
          const unitPriceCents = it.unit_price_cents_snapshot;
          const lineTotalCents =
            (it.unit_price_cents_snapshot + it.modifier_total_cents) *
            it.quantity;

          const orderItemResult = await q(
            'insert order_item',
            `INSERT INTO order_items (
               restaurant_id,
               order_id,
               menu_item_id,
               name_snapshot,
               unit_price_cents_snapshot,
               quantity,
               line_total_cents
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id`,
            [
              restaurantIdFinal,
              order.id,
              it.menu_item_id,
              it.name_snapshot,
              unitPriceCents,
              it.quantity,
              lineTotalCents,
            ]
          );

          const orderItemId = orderItemResult.rows[0].id;

          for (const modifier of it.modifiers) {
            await q(
              'insert order_item_modifier',
              `INSERT INTO order_item_modifiers (
                 restaurant_id,
                 order_item_id,
                 group_id,
                 option_id,
                 group_name_snapshot,
                 option_name_snapshot,
                 price_delta_cents_snapshot,
                 quantity
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                restaurantIdFinal,
                orderItemId,
                modifier.group_id,
                modifier.option_id,
                modifier.group_name_snapshot,
                modifier.option_name_snapshot,
                modifier.price_delta_cents_snapshot,
                modifier.quantity,
              ]
            );
          }
        }

        // Phase 17 — Always write ORDER_CREATED for every successful order creation.
        // When an idempotency key is present, persist it in event metadata for safe retry lookup.
        const createEventMeta = idempotencyKey
          ? {
              signature: stableItemHashPayload(
                restaurantIdFinal,
                tableId,
                items
              ),
            }
          : {};

        await q(
          'insert order created event',
          `INSERT INTO order_events (
             order_id,
             restaurant_id,
             actor_user_id,
             actor_firebase_uid,
             actor_type,
             actor_role,
             event_type,
             from_status,
             to_status,
             meta,
             idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,'ORDER_CREATED',NULL,'OPEN',$7::jsonb,$8)`,
          [
            order.id,
            restaurantIdFinal,
            actorUserIdForDb,
            actorFirebaseUidForDb,
            actorTypeForDb,
            actorRoleForDb,
            JSON.stringify(createEventMeta),
            idempotencyKey || null,
          ]
        );



        await q('COMMIT', 'COMMIT');
        return res.status(201).json({ order });
      } catch (err) {
        req.logEvent?.('error', {
          at: 'orders.routes',
          event: 'order.transaction_failed',
          requestId: req.requestId || null,
          failureType: isDbUnavailableErr(err)
            ? 'database_unavailable'
            : 'order_creation_failed',
        });

        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          req.logEvent?.('error', {
            at: 'orders.routes',
            event: 'order.transaction_rollback_failed',
            requestId: req.requestId || null,
            failureType: isDbUnavailableErr(rollbackErr)
              ? 'database_unavailable'
              : 'database_operation_failed',
          });
        }

        // Let global error middleware classify DB outages to 503 (Phase 9.5A)
        return next(err);
      } finally {
        client?.release();
      }
    }
  );

  // List order history
  router.get('/history', verifyToken, async (req, res) => {
    try {
      const ctx = await resolveActorContext(req);
      const rows = await OrdersQ.listHistoryScoped(pool, ctx);
      res.json({ history: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Filter by status
  router.get('/status/:status', verifyToken, async (req, res) => {
    const { status } = req.params;
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    try {
      const ctx = await resolveActorContext(req);
      const rows = await OrdersQ.listByStatusScoped(pool, status, ctx);
      res.json({ orders: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Phase 8.0 — Canonical active-order awareness route for FloorBoard and other POS awareness surfaces.
  // Manager scope: all active restaurant orders.
  // Employee awareness scope: all table-linked active dining-room orders for the restaurant.
  router.get('/active', verifyToken, async (req, res) => {
    try {
      const ctx = await resolveActorContext(req);
      const rows = await OrdersQ.listActiveScoped(pool, ctx);

      // Phase 17 — DEBUG: log aggregate active orders payload


      return res.status(200).json({ active_orders: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Phase 8.0 — Canonical table-detail active-order route for POS control surfaces.
  // Table Detail remains table-scoped, restaurant-scoped, and deterministic.
  router.get('/table/:tableId/active', verifyToken, async (req, res) => {
    const tableId = typeof req.params.tableId === 'string' ? req.params.tableId.trim() : '';

    if (!tableId) {
      return res.status(400).json({ error: 'Invalid table id' });
    }

    try {
      const ctx = await resolveActorContext(req);
      const rows = await OrdersQ.listActiveForTableScoped(pool, tableId, ctx);
      return res.status(200).json({ orders: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Phase 24 — POS table reset flow.
  // Backend-truth reset: close eligible resolved table activity and let POS reload from active-order truth.
  router.post('/table/:tableId/reset', verifyToken, async (req, res) => {
    const tableId = typeof req.params.tableId === 'string' ? req.params.tableId.trim() : '';

    if (!tableId) {
      return res.status(400).json({ error: 'Invalid table id' });
    }

    try {
      const ctx = await resolveActorContext(req);

      if (!isOperationalScope(ctx.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const cur = await pool.query(
        `SELECT id, status, total_cents, paid_cents, comped_cents
         FROM orders
         WHERE restaurant_id = $1
           AND table_id = $2
           AND status NOT IN ('CLOSED', 'CANCELLED')
         ORDER BY opened_at DESC NULLS LAST, id DESC`,
        [ctx.restaurantId, tableId]
      );

      const rows = cur.rows || [];
      const blockingOrder = rows.find((order) => {
        const status = String(order.status || '').toUpperCase();
        const total = Number.isInteger(order.total_cents) ? order.total_cents : 0;
        const paid = Number.isInteger(order.paid_cents) ? order.paid_cents : 0;
        const comped = Number.isInteger(order.comped_cents)
          ? order.comped_cents
          : 0;
        const isFullySettled = paid + comped >= total && total >= 0;

        if (status === 'SENT') return true;
        if (status === 'OPEN') return true;
        if (status === 'READY' && !isFullySettled) return true;
        return false;
      });

      if (blockingOrder) {
        return res.status(409).json({
          error: 'Complete or close all orders before resetting',
          code: 'TABLE_RESET_BLOCKED',
          blocking_order_id: blockingOrder.id,
          blocking_status: blockingOrder.status,
        });
      }

      const eligibleOrders = rows.filter((order) => {
        const status = String(order.status || '').toUpperCase();
        const total = Number.isInteger(order.total_cents) ? order.total_cents : 0;
        const paid = Number.isInteger(order.paid_cents) ? order.paid_cents : 0;
        const comped = Number.isInteger(order.comped_cents)
          ? order.comped_cents
          : 0;

        return status === 'READY' && paid + comped >= total && total >= 0;
      });

      if (eligibleOrders.length === 0) {
        return res.status(200).json({
          table_id: tableId,
          reset: true,
          closed_order_ids: [],
          is_noop: true,
        });
      }

      const closedOrderIds = [];

      for (const order of eligibleOrders) {
        const out = await OrdersLifecycle.transitionOrderStatus(pool, {
          orderId: order.id,
          restaurantId: ctx.restaurantId,
          nextStatus: 'CLOSED',
          actor: ctx,
          meta: { source: 'orders.routes.tableReset' },
        });

        if (out?.notFound) {
          continue;
        }

        if (out?.invalidTransition) {
          return res.status(409).json({
            error: 'Invalid status transition',
            order_id: out.order_id,
            previous_state: out.previous_state,
            requested_state: out.requested_state,
          });
        }

        if (out?.order_id) {
          closedOrderIds.push(out.order_id);
        }
      }

      return res.status(200).json({
        table_id: tableId,
        reset: true,
        closed_order_ids: closedOrderIds,
        is_noop: closedOrderIds.length === 0,
      });
    } catch (err) {
      req.logEvent?.('error', {
        at: 'orders.routes',
        event: 'table.reset_failed',
        requestId: req.requestId || null,
        failureType: isDbUnavailableErr(err)
          ? 'database_unavailable'
          : 'table_reset_failed',
      });
      handleErrorWithStatus(res, err);
    }
  });

    // Phase 7.2 — Manager-only: void an order (CANCELLED) with audit event
    router.post(
        '/:id/void',
        verifyToken,
        validate({
          reason: (v) => typeof v === 'string' && v.trim().length > 0,
        }),
        async (req, res) => {
          const orderId = req.params.id;
          if (!isUuid(orderId)) return res.status(400).json({ error: 'Invalid order id' });
    
          const reason = String(req.body.reason || '').trim();
    
          try {
            const ctx = await requireManagerScope(req, res);
            if (!ctx) return;
    
            const cur = await pool.query(
              `SELECT id, status
               FROM orders
               WHERE id = $1 AND restaurant_id = $2
               LIMIT 1`,
              [orderId, ctx.restaurantId]
            );
    
            if (cur.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    
            const fromStatus = String(cur.rows[0].status || '').toUpperCase();
    
            if (fromStatus === 'CANCELLED') {
              return res.status(200).json({ order_id: orderId, status: 'CANCELLED', is_noop: true });
            }
    
            const out = await OrdersLifecycle.transitionOrderStatus(pool, {
              orderId,
              restaurantId: ctx.restaurantId,
              nextStatus: 'CANCELLED',
              actor: ctx,
              meta: { source: 'orders.routes.void', reason },
            });
    
            if (out?.notFound) return res.status(404).json({ error: 'Order not found' });
    
            if (out?.invalidTransition) {
              return res.status(409).json({
                error: 'Invalid status transition',
                order_id: out.order_id,
                previous_state: out.previous_state,
                requested_state: out.requested_state,
              });
            }
    
    
            return res.status(200).json({ order_id: out.order_id || orderId, status: 'CANCELLED' });
          } catch (err) {
            handleErrorWithStatus(res, err);
          }
        }
      );
    
      // Phase 40F — Manager-only comp using authoritative comped_cents settlement.
      router.post(
        '/:id/comp',
        verifyToken,
        validate({
          reason: (v) => typeof v === 'string' && v.trim().length > 0,
        }),
        async (req, res) => {
          const orderId = req.params.id;
          if (!isUuid(orderId)) return res.status(400).json({ error: 'Invalid order id' });

          const reason = String(req.body.reason || '').trim();

          try {
            const ctx = await requireManagerScope(req, res);
            if (!ctx) return;

            const out = await OrdersLifecycle.compOrder(pool, {
              orderId,
              restaurantId: ctx.restaurantId,
              actor: ctx,
              meta: { source: 'orders.routes.comp', reason, payment_method: 'comp' },
            });

            if (out?.notFound) {
              return res.status(404).json({ error: 'Order not found' });
            }

            if (out?.invalidState) {
              return res.status(409).json({
                error: 'Cannot comp a cancelled order',
                order_id: out.order_id,
                current_state: out.current_state,
              });
            }

            if (out?.is_noop) {
              return res.status(200).json({
                order_id: out.order_id,
                total_cents: out.total_cents,
                paid_cents: out.paid_cents,
                comped_cents: out.comped_cents,
                is_noop: true,
              });
            }

            return res.status(200).json({
              order_id: out.order_id,
              status: out.current_state,
              total_cents: out.total_cents,
              paid_cents: out.paid_cents,
              comped_cents: out.comped_cents,
            });
          } catch (err) {
            req.logEvent?.(
              'error',
              'order_comp_exception',
              {
                name: err?.name || null,
                code: err?.code || null,
                constraint: err?.constraint || null,
                table: err?.table || null,
                column: err?.column || null,
                message: err?.message || null,
              }
            );

            handleErrorWithStatus(res, err);
          }
        }
      );
    
      // Phase 40F — Manager-only atomic status override with canonical audit event.
      router.post(
        '/:id/override-status',
        verifyToken,
        validate({
          to_status: (v) =>
            typeof v === 'string' &&
            allowedStatus.includes(String(v).toUpperCase()),
          reason: (v) => typeof v === 'string' && v.trim().length > 0,
        }),
        async (req, res) => {
          const orderId = req.params.id;

          if (!isUuid(orderId)) {
            return res.status(400).json({ error: 'Invalid order id' });
          }

          const toStatus = String(req.body.to_status || '').toUpperCase();
          const reason = String(req.body.reason || '').trim();

          try {
            const ctx = await requireManagerScope(req, res);
            if (!ctx) return;

            const out = await OrdersLifecycle.overrideOrderStatus(pool, {
              orderId,
              restaurantId: ctx.restaurantId,
              nextStatus: toStatus,
              actor: ctx,
              meta: { reason },
            });

            if (out?.notFound) {
              return res.status(404).json({ error: 'Order not found' });
            }

            return res.status(200).json({
              order_id: out.order_id,
              previous_status: out.previous_state,
              status: out.current_state,
              is_noop: Boolean(out.is_noop),
            });
          } catch (err) {
            handleErrorWithStatus(res, err);
          }
        }
      );

  // KDS active (SENT + READY)
  router.get('/kds/active', verifyToken, async (_req, res) => {
    try {
      const ctx = await requireKitchenScope(_req, res);
      if (!ctx) return;

      const rows = await OrdersQ.listKdsActiveScoped(pool, ctx);
      res.json({ active_orders: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // KDS completed (CLOSED)
  router.get('/kds/completed', verifyToken, async (_req, res) => {
    try {
      const ctx = await requireKitchenScope(_req, res);
      if (!ctx) return;
      const rows = await OrdersQ.listKdsCompletedScoped(pool, ctx);
      res.json({ completed_orders: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Phase 4.2 — Order event timeline (audit log)
  router.get('/:id/events', verifyToken, async (req, res) => {
    const orderId = req.params.id;

    if (!isUuid(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    try {
      // Removed dangerous logging (Phase 9.1.B)
      const ctx = await resolveActorContext(req);
      const managerScope = isManagerScope(ctx.role);

      const visibleOrder = await pool.query(
        `SELECT id, table_id, created_by_user_id
         FROM orders
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [orderId, ctx.restaurantId]
      );

      if (visibleOrder.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }

      if (!managerScope) {
        const row = visibleOrder.rows[0];

        if (ctx.role === 'Employee') {
          const hasAssignment = await employeeHasActiveTableAssignment({
            restaurantId: ctx.restaurantId,
            tableId: row.table_id,
            userId: ctx.userId,
          });

          if (!hasAssignment) {
            return res.status(404).json({ error: 'Order not found or unauthorized' });
          }
        } else if (ctx.role === 'Customer') {
          if (row.created_by_user_id !== ctx.userId) {
            return res.status(404).json({ error: 'Order not found or unauthorized' });
          }
        } else {
          return res.status(404).json({ error: 'Order not found or unauthorized' });
        }
      }

      const rows = await OrdersQ.getOrderEventsScoped(pool, orderId, ctx.restaurantId);
      return res.status(200).json({ events: rows });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Get single order by id
  router.get('/:id', verifyToken, async (req, res) => {
    const orderId = req.params.id;

    if (!isUuid(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    try {
      const ctx = await resolveActorContext(req);
      const managerScope = isManagerScope(ctx.role);

      const scopedOrderRows = await pool.query(
        `SELECT *
         FROM orders
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [orderId, ctx.restaurantId]
      );

      const order = scopedOrderRows.rows?.[0] || null;

      if (!order) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }

      if (!managerScope) {
        if (ctx.role === 'Customer') {
          if (order.created_by_user_id !== ctx.userId) {
            return res.status(404).json({ error: 'Order not found or unauthorized' });
          }
        } else if (ctx.role === 'Employee') {
          const kitchenVisible =
            order.status === 'SENT' ||
            order.status === 'READY';

          const createdByEmployee =
            order.created_by_user_id === ctx.userId;

          const hasAssignment =
            !kitchenVisible &&
            order.table_id
              ? await employeeHasActiveTableAssignment({
                  restaurantId: ctx.restaurantId,
                  tableId: order.table_id,
                  userId: ctx.userId,
                })
              : false;

          if (
            !createdByEmployee &&
            !hasAssignment &&
            !kitchenVisible
          ) {
            return res.status(404).json({ error: 'Order not found or unauthorized' });
          }
        } else {
          return res.status(404).json({ error: 'Order not found or unauthorized' });
        }
      }

      const items = await pool.query(
        `SELECT *
         FROM order_items
         WHERE order_id = $1
           AND restaurant_id = $2
         ORDER BY created_at ASC NULLS LAST, id ASC`,
        [orderId, ctx.restaurantId]
      );

      order.items = items.rows || [];

      return res.status(200).json({ order });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Phase 6.4 — POS payment capture (Option B)
  // Marks an order as fully paid so it can transition OPEN -> SENT.
  // This does NOT process a card charge; it records that payment has been collected by staff.
  router.put('/:id/pay', verifyToken, async (req, res) => {
    const orderId = req.params.id;
    const payment_method = typeof req.body?.payment_method === 'string' ? req.body.payment_method : null;

    if (!isUuid(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    if (!payment_method || !allowedPaymentMethod.includes(payment_method)) {
      return res.status(400).json({ error: "Invalid or missing 'payment_method' (cash|card)" });
    }

    try {
      const ctx = await resolveActorContext(req);

      if (!isOperationalScope(ctx.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const managerScope = isManagerScope(ctx.role);
      const params = managerScope ? [orderId, ctx.restaurantId] : [orderId, ctx.restaurantId, ctx.userId];
      const userPred = managerScope ? '' : ' AND created_by_user_id = $3';

      // Only allow paying an order that exists. We also enforce "fully paid" semantics here.
      const cur = await pool.query(
        `SELECT id, status, total_cents, paid_cents
         FROM orders
         WHERE id = $1
           AND restaurant_id = $2${userPred}
         LIMIT 1`,
        params
      );

      if (cur.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }

      const row = cur.rows[0];
      const total_cents = Number.isInteger(row.total_cents) ? row.total_cents : 0;
      const paid_cents = Number.isInteger(row.paid_cents) ? row.paid_cents : 0;

      // If already fully paid, treat as idempotent success.
      if (paid_cents >= total_cents && total_cents >= 0) {
        return res.status(200).json({
          order_id: row.id,
          total_cents,
          paid_cents,
          payment_method,
          is_noop: true,
        });
      }

      // Do not allow paying cancelled orders.
      if (String(row.status).toUpperCase() === 'CANCELLED') {
        return res.status(409).json({ error: 'Cannot pay a cancelled order' });
      }

      const updParams = managerScope ? [orderId, ctx.restaurantId] : [orderId, ctx.restaurantId, ctx.userId];
      const updUserPred = managerScope ? '' : ' AND created_by_user_id = $3';

      const upd = await pool.query(
        `UPDATE orders
         SET paid_cents = total_cents
         WHERE id = $1
           AND restaurant_id = $2${updUserPred}
         RETURNING id, total_cents, paid_cents`,
        updParams
      );

      if (upd.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }

      const out = upd.rows[0];

      return res.status(200).json({
        order_id: out.id,
        total_cents: out.total_cents,
        paid_cents: out.paid_cents,
        payment_method,
        is_noop: false,
      });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Update order status (authoritative)
  router.put('/:id/status', verifyToken, async (req, res) => {
    const { status } = req.body;
    const orderId = req.params.id;

    if (!isUuid(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    try {
      const ctx = await resolveActorContext(req);
      const managerScope = isManagerScope(ctx.role);

      // Phase 28 — Manager overrides are manager-only.
      // Allowed non-manager transitions:
      // OPEN -> SENT (only when fully paid)
      // SENT -> READY (Kitchen authority)
      // Recall transitions are manager-only and must not be available to staff:
      // SENT -> OPEN
      // READY -> OPEN
      // READY -> SENT
      if (!managerScope) {
        const requestedStatus = String(status || '').toUpperCase();

        // Enforce per-order visibility + transition gating from backend truth.
        const cur = await pool.query(
          `SELECT id, status, total_cents, paid_cents, created_by_user_id, table_id
           FROM orders
           WHERE id = $1 AND restaurant_id = $2
           LIMIT 1`,
          [orderId, ctx.restaurantId]
        );

        if (cur.rowCount === 0) {
          return res.status(404).json({ error: 'Order not found or unauthorized' });
        }

        const row = cur.rows[0];
        const fromStatus = String(row.status || '').toUpperCase();

        let visibleToActor = false;

        if (ctx.role === 'Employee') {
          const isKitchenReadyTransition =
            fromStatus === 'SENT' && requestedStatus === 'READY';

          visibleToActor = isKitchenReadyTransition
            ? true
            : await employeeHasActiveTableAssignment({
                restaurantId: ctx.restaurantId,
                tableId: row.table_id,
                userId: ctx.userId,
              });
        } else if (ctx.role === 'Customer') {
          visibleToActor = row.created_by_user_id === ctx.userId;
        }

        req.logEvent?.('debug', {
          at: 'orders.routes',
          event: 'order.status_visibility_evaluated',
          requestId: req.requestId || null,
          visibleToActor,
        });

        if (!visibleToActor) {
          return res.status(404).json({ error: 'Order not found or unauthorized' });
        }

        const allowedStaffTransitions = {
          OPEN: new Set(['SENT']),
          SENT: new Set(['READY']),
        };

        const allowedNext = allowedStaffTransitions[fromStatus] || new Set();
        if (!allowedNext.has(requestedStatus)) {
          return res.status(409).json({
            error: 'Invalid status transition',
            order_id: orderId,
            previous_state: fromStatus,
            requested_state: requestedStatus,
          });
        }

        if (fromStatus === 'OPEN' && requestedStatus === 'SENT') {
          const total = Number.isInteger(row.total_cents) ? row.total_cents : 0;
          const paid = Number.isInteger(row.paid_cents) ? row.paid_cents : 0;
          if (!(paid >= total && total >= 0)) {
            return res.status(409).json({ error: 'Order must be fully paid before sending' });
          }
        }
      }

      const out = await OrdersLifecycle.transitionOrderStatus(pool, {
        orderId,
        restaurantId: ctx.restaurantId,
        nextStatus: String(status).toUpperCase(),
        actor: ctx,
        meta: {
          source: 'orders.routes.putStatus',
          reason: req.body?.meta?.reason,
        },
      });

      if (out?.notFound) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }

      if (out?.invalidTransition) {
        return res.status(409).json({
          error: 'Invalid status transition',
          order_id: out.order_id,
          previous_state: out.previous_state,
          requested_state: out.requested_state,
        });
      }

      return res.status(200).json({
        order_id: out.order_id,
        previous_state: out.previous_state,
        current_state: out.current_state,
        sent_at: out.sent_at,
        ready_at: out.ready_at,
        closed_at: out.closed_at,
        recalled_at: out.recalled_at,
        is_noop: out.is_noop,
      });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  // Priority update (manager-only)
  router.put('/:id/priority', verifyToken, async (req, res) => {
    const { priority } = req.body;
    const orderId = req.params.id;

    if (!isUuid(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    if (!allowedPriority.includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority value' });
    }

    try {
      const ctx = await resolveActorContext(req);
      if (!isManagerScope(ctx.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const result = await pool.query(
        `UPDATE orders
         SET priority = $1
         WHERE id = $2
           AND restaurant_id = $3
         RETURNING *`,
        [priority, orderId, ctx.restaurantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }

      return res.json({ order: result.rows[0] });
    } catch (err) {
      handleErrorWithStatus(res, err);
    }
  });

  return router;
};