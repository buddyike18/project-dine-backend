const express = require('express');
const { resolveActor } = require('../middleware/resolveActor');

const STAFF_ASSIGNMENT_VIEW_ROLES = new Set(['Manager', 'Employee']);
const STAFF_ASSIGNMENT_MANAGE_ROLES = new Set(['Manager']);

function requireRole(actor, allowedRoles) {
  if (!actor?.role || !allowedRoles.has(actor.role)) {
    const error = new Error('Forbidden');
    error.status = 403;
    error.statusCode = 403;
    throw error;
  }
}

function sendActorError(req, res, error, reason) {
  const statusCode = Number(error?.statusCode || error?.status || 500);

  if (statusCode === 401) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (statusCode === 403) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.logEvent?.(
    'error',
    'table_assignment_request_failed',
    { reason }
  );

  return res.status(500).json({
    error: 'Internal server error',
  });
}

module.exports = function tableAssignmentsRoutes(pool, verifyToken, requireRoles) {
  const router = express.Router();

  router.get('/', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireRole(actor, STAFF_ASSIGNMENT_VIEW_ROLES);
      const restaurantId = actor.restaurantId;

      const result = await pool.query(
        `
          SELECT
            ta.id,
            ta.restaurant_id,
            ta.table_id,
            ta.staff_user_id,
            ta.active,
            ta.created_at,
            ta.updated_at,
            u.name AS staff_name,
            u.role AS staff_role,
            u.active AS staff_active
          FROM table_assignments ta
          JOIN users u
            ON u.id = ta.staff_user_id
           AND u.restaurant_id = ta.restaurant_id
          WHERE ta.restaurant_id = $1
          ORDER BY ta.table_id ASC
        `,
        [restaurantId]
      );

      res.json({ assignments: result.rows });
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'TABLE_ASSIGNMENTS_LIST_FAILED'
      );
    }
  });

  router.put('/', verifyToken, async (req, res) => {
    let actor;
    let restaurantId;

    try {
      actor = await resolveActor(pool, req);
      requireRole(actor, STAFF_ASSIGNMENT_MANAGE_ROLES);
      restaurantId = actor.restaurantId;
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'TABLE_ASSIGNMENT_UPSERT_FAILED'
      );
    }

    const tableId =
      req.body?.table_id === undefined || req.body?.table_id === null
        ? ''
        : String(req.body.table_id).trim();
    const staffUserId =
      typeof req.body?.staff_user_id === 'string' ? req.body.staff_user_id.trim() : '';

    if (!tableId) {
      return res.status(400).json({ error: 'table_id is required' });
    }

    if (!staffUserId) {
      return res.status(400).json({ error: 'staff_user_id is required' });
    }

    try {
      const staffResult = await pool.query(
        `
          SELECT id, name, role, active
          FROM users
          WHERE id = $1
            AND restaurant_id = $2
        `,
        [staffUserId, restaurantId]
      );

      if (staffResult.rowCount === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }

      const staffMember = staffResult.rows[0];

      if (!staffMember.active) {
        return res.status(400).json({ error: 'Cannot assign an inactive staff member' });
      }

      if (staffMember.role === 'Customer') {
        return res.status(400).json({ error: 'Cannot assign a customer to a table' });
      }

      const result = await pool.query(
        `
          INSERT INTO table_assignments (
            restaurant_id,
            table_id,
            staff_user_id,
            active,
            updated_at
          )
          VALUES ($1, $2, $3, true, now())
          ON CONFLICT (restaurant_id, table_id)
          DO UPDATE SET
            staff_user_id = EXCLUDED.staff_user_id,
            active = true,
            updated_at = now()
          RETURNING
            id,
            restaurant_id,
            table_id,
            staff_user_id,
            active,
            created_at,
            updated_at
        `,
        [restaurantId, tableId, staffUserId]
      );

      res.json({ assignment: result.rows[0] });
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'TABLE_ASSIGNMENT_UPSERT_FAILED'
      );
    }
  });

  router.delete('/:tableId', verifyToken, async (req, res) => {
    let actor;
    let restaurantId;

    try {
      actor = await resolveActor(pool, req);
      requireRole(actor, STAFF_ASSIGNMENT_MANAGE_ROLES);
      restaurantId = actor.restaurantId;
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'TABLE_ASSIGNMENT_DELETE_FAILED'
      );
    }

    const tableId = String(req.params?.tableId ?? '').trim();

    if (!tableId) {
      return res.status(400).json({ error: 'tableId is required' });
    }

    try {
      const result = await pool.query(
        `
          UPDATE table_assignments
          SET active = false,
              updated_at = now()
          WHERE restaurant_id = $1
            AND table_id = $2
          RETURNING
            id,
            restaurant_id,
            table_id,
            staff_user_id,
            active,
            created_at,
            updated_at
        `,
        [restaurantId, tableId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Assignment not found' });
      }

      res.json({ assignment: result.rows[0] });
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'TABLE_ASSIGNMENT_DELETE_FAILED'
      );
    }
  });

  return router;
};