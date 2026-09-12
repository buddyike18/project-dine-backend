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

  console.error(reason, error);
  return res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal server error' : error.message,
  });
}

module.exports = (pool, verifyToken) => {
  const router = express.Router();

  router.get('/', verifyToken, async (req, res) => {
    let actor;
    let restaurantId;

    try {
      actor = await resolveActor(pool, req);
      requireRole(actor, STAFF_ASSIGNMENT_VIEW_ROLES);
      restaurantId = actor.restaurantId;
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'BAR_ASSIGNMENT_LIST_FAILED'
      );
    }

    try {
      const result = await pool.query(
        `
          SELECT
            ba.id,
            ba.restaurant_id,
            ba.staff_user_id,
            ba.active,
            ba.created_at,
            ba.updated_at,
            u.name AS staff_name,
            u.role AS staff_role
          FROM bar_assignments ba
          JOIN users u
            ON u.id = ba.staff_user_id
          WHERE ba.restaurant_id = $1
            AND ba.active = true
          ORDER BY u.name ASC, ba.created_at ASC
        `,
        [restaurantId]
      );

      return res.json({ assignments: result.rows });
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'BAR_ASSIGNMENT_LIST_FAILED'
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
        'BAR_ASSIGNMENT_UPSERT_FAILED'
      );
    }

    const staffUserId = String(req.body?.staff_user_id ?? '').trim();

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
        return res.status(400).json({
          error: 'Cannot assign an inactive staff member',
        });
      }

      if (staffMember.role === 'Customer') {
        return res.status(400).json({
          error: 'Cannot assign a customer to the bar',
        });
      }

      const result = await pool.query(
        `
          INSERT INTO bar_assignments (
            restaurant_id,
            staff_user_id,
            active,
            updated_at
          )
          VALUES ($1, $2, true, now())
          ON CONFLICT (restaurant_id, staff_user_id)
          DO UPDATE SET
            active = true,
            updated_at = now()
          RETURNING
            id,
            restaurant_id,
            staff_user_id,
            active,
            created_at,
            updated_at
        `,
        [restaurantId, staffUserId]
      );

      return res.json({ assignment: result.rows[0] });
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'BAR_ASSIGNMENT_UPSERT_FAILED'
      );
    }
  });

  router.delete('/:staffUserId', verifyToken, async (req, res) => {
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
        'BAR_ASSIGNMENT_DELETE_FAILED'
      );
    }

    const staffUserId = String(req.params?.staffUserId ?? '').trim();

    if (!staffUserId) {
      return res.status(400).json({ error: 'staffUserId is required' });
    }

    try {
      const result = await pool.query(
        `
          UPDATE bar_assignments
          SET active = false,
              updated_at = now()
          WHERE restaurant_id = $1
            AND staff_user_id = $2
          RETURNING
            id,
            restaurant_id,
            staff_user_id,
            active,
            created_at,
            updated_at
        `,
        [restaurantId, staffUserId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Assignment not found' });
      }

      return res.json({ assignment: result.rows[0] });
    } catch (error) {
      return sendActorError(
        req,
        res,
        error,
        'BAR_ASSIGNMENT_DELETE_FAILED'
      );
    }
  });

  return router;
};
