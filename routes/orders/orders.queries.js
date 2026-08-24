'use strict';

/**
 * orders.queries.js
 *
 * Phase: orders.js restructuring (Phase 4.2 frozen)
 *
 * This module contains SQL-only data access helpers for orders.
 * No business logic (state machine) should live here.
 *
 * IMPORTANT: These helpers are not wired yet; a later step will update routes to call them.
 */

/**
 * Phase 7.1: POS role boundaries (visibility enforced in SQL).
 *
 * The POS must consume backend results as-is.
 * Employees may only see orders they created.
 * Managers (and above) may see all restaurant orders.
 *
 * NOTE: This module remains SQL-only. Role checks here only determine SQL scope.
 */
const MANAGER_ROLES = new Set(['manager', 'owner', 'admin']);

/**
 * @typedef {Object} OrderVisibilityContext
 * @property {string} restaurantId uuid
 * @property {string} role lowercased role string
 * @property {string} userId uuid
 */

function isManagerScope(role) {
  if (!role) return false;
  return MANAGER_ROLES.has(String(role).toLowerCase());
}

/**
 * Get a single order with aggregated item snapshots.
 * @param {import('pg').Pool} pool
 * @param {string} orderId uuid
 */
async function getOrderByIdWithItems(pool, orderId) {
  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
     FROM orders o
     LEFT JOIN order_items oi ON o.id = oi.order_id
     WHERE o.id = $1
     GROUP BY o.id
     LIMIT 1`,
    [orderId]
  );
  return result.rows[0] || null;
}

/**
 * List historical orders (existing behavior: restaurant_id IS NOT NULL).
 * @param {import('pg').Pool} pool
 */
async function listHistory(pool) {
  const result = await pool.query(`
    SELECT o.*,
           COALESCE(json_agg(json_build_object(
             'menu_item_id', oi.menu_item_id,
             'name', oi.name_snapshot,
             'quantity', oi.quantity,
             'unit_price_cents', oi.unit_price_cents_snapshot,
             'line_total_cents', oi.line_total_cents
           )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
     WHERE o.restaurant_id IS NOT NULL
     GROUP BY o.id
     ORDER BY o.opened_at DESC, o.id DESC
  `);
  return result.rows;
}

/**
 * Phase 8.0: Canonical active-order awareness query for POS surfaces.
 * - Always scoped to restaurant_id
 * - Active lifecycle is OPEN, SENT, READY
 * - Manager scope may see all active orders for the restaurant
 * - Employee awareness scope may see all table-linked active dining-room orders
 * - Deterministic ordering is required for polling stability
 * @param {import('pg').Pool} pool
 * @param {OrderVisibilityContext} ctx
 */
async function listActiveScoped(pool, ctx) {
  const restaurantId = ctx?.restaurantId;
  const role = ctx?.role;

  if (!restaurantId) throw new Error('listActiveScoped: restaurantId is required');
  if (!role) throw new Error('listActiveScoped: role is required');

  const managerScope = isManagerScope(role);
  const params = [restaurantId, managerScope];

  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.restaurant_id = $1
        AND o.status IN ('OPEN', 'SENT', 'READY')
        AND ($2::boolean = true OR o.table_id IS NOT NULL)
      GROUP BY o.id
      ORDER BY o.opened_at ASC, o.id ASC`,
    params
  );

  return result.rows;
}

/**
 * Phase 8.0: Canonical table-detail active-order query for POS control surfaces.
 * - Always scoped to restaurant_id
 * - Always scoped to an exact table_id match
 * - Active lifecycle is OPEN, SENT, READY
 * - Table Detail must remain complete for the table during live service
 * - Deterministic ordering is required for polling/reload stability
 * @param {import('pg').Pool} pool
 * @param {string} tableId
 * @param {OrderVisibilityContext} ctx
 */
async function listActiveForTableScoped(pool, tableId, ctx) {
  const restaurantId = ctx?.restaurantId;
  const role = ctx?.role;

  if (!tableId) throw new Error('listActiveForTableScoped: tableId is required');
  if (!restaurantId) throw new Error('listActiveForTableScoped: restaurantId is required');
  if (!role) throw new Error('listActiveForTableScoped: role is required');

  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.restaurant_id = $1
        AND o.table_id = $2
        AND o.status IN ('OPEN', 'SENT', 'READY')
      GROUP BY o.id
      ORDER BY o.opened_at DESC, o.id DESC`,
    [restaurantId, tableId]
  );

  return result.rows;
}

/**
 * Phase 7.1: List historical orders with backend-enforced visibility.
 * - Always scoped to restaurant_id
 * - If not manager-scope, also scoped to created_by_user_id
 * @param {import('pg').Pool} pool
 * @param {OrderVisibilityContext} ctx
 */
async function listHistoryScoped(pool, ctx) {
  const restaurantId = ctx?.restaurantId;
  const role = ctx?.role;
  const userId = ctx?.userId;

  if (!restaurantId) throw new Error('listHistoryScoped: restaurantId is required');
  if (!role) throw new Error('listHistoryScoped: role is required');
  if (!isManagerScope(role) && !userId) throw new Error('listHistoryScoped: userId is required for employee scope');

  const managerScope = isManagerScope(role);

  const params = managerScope ? [restaurantId] : [restaurantId, userId];
  const userPredicate = managerScope ? '' : ' AND o.created_by_user_id IS NOT NULL AND o.created_by_user_id = $2';

  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.restaurant_id = $1${userPredicate}
      GROUP BY o.id
      ORDER BY o.opened_at DESC, o.id DESC`,
    params
  );

  return result.rows;
}

/**
 * List orders by status with aggregated items.
 * @param {import('pg').Pool} pool
 * @param {string} status
 */
async function listByStatus(pool, status) {
  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.status = $1
      GROUP BY o.id
      ORDER BY o.opened_at DESC, o.id DESC`,
    [status]
  );
  return result.rows;
}

/**
 * Phase 7.1: List orders by status with backend-enforced visibility.
 * - Always scoped to restaurant_id
 * - If not manager-scope, also scoped to created_by_user_id
 * @param {import('pg').Pool} pool
 * @param {string} status
 * @param {OrderVisibilityContext} ctx
 */
async function listByStatusScoped(pool, status, ctx) {
  const restaurantId = ctx?.restaurantId;
  const role = ctx?.role;
  const userId = ctx?.userId;

  if (!status) throw new Error('listByStatusScoped: status is required');
  if (!restaurantId) throw new Error('listByStatusScoped: restaurantId is required');
  if (!role) throw new Error('listByStatusScoped: role is required');
  if (!isManagerScope(role) && !userId) throw new Error('listByStatusScoped: userId is required for employee scope');

  const managerScope = isManagerScope(role);

  // Param order is fixed for clarity:
  // $1 restaurantId
  // $2 status
  // $3 userId (employee scope only)
  const params = managerScope ? [restaurantId, status] : [restaurantId, status, userId];
  const userPredicate = managerScope ? '' : ' AND o.created_by_user_id IS NOT NULL AND o.created_by_user_id = $3';

  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.restaurant_id = $1
        AND o.status = $2${userPredicate}
      GROUP BY o.id
      ORDER BY o.opened_at DESC, o.id DESC`,
    params
  );

  return result.rows;
}

/**
 * Phase 17: KDS active orders, restaurant-scoped for kitchen staff.
 * - Always scoped to restaurant_id
 * - Kitchen must see SENT and READY orders for the restaurant
 * - Employee and manager scopes are both allowed at the query layer
 * - No created_by_user_id restriction should apply on KDS
 * @param {import('pg').Pool} pool
 * @param {OrderVisibilityContext} ctx
 */
async function listKdsActiveScoped(pool, ctx) {
  const restaurantId = ctx?.restaurantId;
  const role = ctx?.role;

  if (!restaurantId) throw new Error('listKdsActiveScoped: restaurantId is required');
  if (!role) throw new Error('listKdsActiveScoped: role is required');

  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.restaurant_id = $1
        AND o.status IN ('SENT', 'READY')
      GROUP BY o.id
      ORDER BY o.opened_at DESC, o.id DESC`,
    [restaurantId]
  );
  return result.rows;
}

/**
 * Phase 17: KDS completed orders, restaurant-scoped for kitchen staff.
 * - Always scoped to restaurant_id
 * - Kitchen may review CLOSED orders for the restaurant
 * - Employee and manager scopes are both allowed at the query layer
 * - No created_by_user_id restriction should apply on KDS
 * @param {import('pg').Pool} pool
 * @param {OrderVisibilityContext} ctx
 */
async function listKdsCompletedScoped(pool, ctx) {
  const restaurantId = ctx?.restaurantId;
  const role = ctx?.role;

  if (!restaurantId) throw new Error('listKdsCompletedScoped: restaurantId is required');
  if (!role) throw new Error('listKdsCompletedScoped: role is required');

  const result = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'menu_item_id', oi.menu_item_id,
              'name', oi.name_snapshot,
              'quantity', oi.quantity,
              'unit_price_cents', oi.unit_price_cents_snapshot,
              'line_total_cents', oi.line_total_cents
            )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.restaurant_id = $1
        AND o.status = 'CLOSED'
      GROUP BY o.id
      ORDER BY o.opened_at DESC, o.id DESC`,
    [restaurantId]
  );
  return result.rows;
}

/**
 * KDS: Active orders (SENT + READY) with aggregated items.
 * @param {import('pg').Pool} pool
 */
async function listKdsActive(pool) {
  const result = await pool.query(`
    SELECT o.*,
           COALESCE(json_agg(json_build_object(
             'menu_item_id', oi.menu_item_id,
             'name', oi.name_snapshot,
             'quantity', oi.quantity,
             'unit_price_cents', oi.unit_price_cents_snapshot,
             'line_total_cents', oi.line_total_cents
           )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
     WHERE o.status IN ('SENT', 'READY')
     GROUP BY o.id
     ORDER BY o.opened_at DESC, o.id DESC
  `);
  return result.rows;
}

/**
 * KDS: Completed orders (CLOSED) with aggregated items.
 * @param {import('pg').Pool} pool
 */
async function listKdsCompleted(pool) {
  const result = await pool.query(`
    SELECT o.*,
           COALESCE(json_agg(json_build_object(
             'menu_item_id', oi.menu_item_id,
             'name', oi.name_snapshot,
             'quantity', oi.quantity,
             'unit_price_cents', oi.unit_price_cents_snapshot,
             'line_total_cents', oi.line_total_cents
           )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
     WHERE o.status = 'CLOSED'
     GROUP BY o.id
     ORDER BY o.opened_at DESC, o.id DESC
  `);
  return result.rows;
}

/**
 * Phase 4.2: Order event timeline.
 * @param {import('pg').Pool} pool
 * @param {string} orderId uuid
 */
async function getOrderEvents(pool, orderId) {
  const result = await pool.query(
    `SELECT id,
            event_type,
            from_status,
            to_status,
            actor_type,
            actor_role,
            actor_user_id,
            actor_firebase_uid,
            meta,
            created_at
       FROM order_events
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC`,
    [orderId]
  );
  return result.rows;
}

/**
 * Phase 7.3: Order event timeline, restaurant-scoped (manager safe).
 * @param {import('pg').Pool} pool
 * @param {string} orderId uuid
 * @param {string} restaurantId uuid
 */
async function getOrderEventsScoped(pool, orderId, restaurantId) {
  const result = await pool.query(
    `SELECT e.id,
            e.event_type,
            e.from_status,
            e.to_status,
            e.actor_type,
            e.actor_role,
            e.actor_user_id,
            e.actor_firebase_uid,
            e.meta,
            e.created_at
       FROM order_events e
       JOIN orders o ON o.id = e.order_id
      WHERE e.order_id = $1
        AND o.restaurant_id = $2
      ORDER BY e.created_at ASC, e.id ASC`,
    [orderId, restaurantId]
  );
  return result.rows;
}

module.exports = {
  getOrderByIdWithItems,
  listActiveScoped,
  listActiveForTableScoped,
  listHistory,
  listHistoryScoped,
  listByStatus,
  listByStatusScoped,
  listKdsActiveScoped,
  listKdsCompletedScoped,
  listKdsActive,
  listKdsCompleted,
  getOrderEvents,
  getOrderEventsScoped,
};