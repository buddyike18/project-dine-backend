'use strict';

async function employeeHasActiveTableAssignment({
  pool,
  restaurantId,
  tableId,
  userId,
}) {
  if (!restaurantId || !tableId || !userId) {
    return false;
  }

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
}

async function employeeHasActiveBarAssignment({
  pool,
  restaurantId,
  userId,
}) {
  if (!restaurantId || !userId) {
    return false;
  }

  const result = await pool.query(
    `SELECT 1
     FROM bar_assignments
     WHERE restaurant_id = $1
       AND staff_user_id = $2
       AND active = true
     LIMIT 1`,
    [restaurantId, userId]
  );

  return result.rowCount > 0;
}

async function employeeOwnsBarCheck({
  pool,
  restaurantId,
  checkId,
  userId,
}) {
  if (!restaurantId || !checkId || !userId) {
    return false;
  }

  const result = await pool.query(
    `SELECT 1
     FROM checks
     WHERE id = $1
       AND restaurant_id = $2
       AND opened_by_user_id = $3
     LIMIT 1`,
    [checkId, restaurantId, userId]
  );

  return result.rowCount > 0;
}

async function employeeCanAccessOrder({
  pool,
  restaurantId,
  userId,
  order,
}) {
  if (!order || !restaurantId || !userId) {
    return false;
  }

  // BAR: active BAR assignment and own check are always required.
  if (order.check_id) {
    const assignedToBar = await employeeHasActiveBarAssignment({
      pool,
      restaurantId,
      userId,
    });

    if (!assignedToBar) {
      return false;
    }

    return employeeOwnsBarCheck({
      pool,
      restaurantId,
      checkId: order.check_id,
      userId,
    });
  }

  // TABLE: creator OR current active table assignment.
  if (order.table_id) {
    if (order.created_by_user_id === userId) {
      return true;
    }

    return employeeHasActiveTableAssignment({
      pool,
      restaurantId,
      tableId: order.table_id,
      userId,
    });
  }

  // QUICK: creator only.
  return order.created_by_user_id === userId;
}

module.exports = {
  employeeHasActiveTableAssignment,
  employeeHasActiveBarAssignment,
  employeeOwnsBarCheck,
  employeeCanAccessOrder,
};
