const express = require('express');
const { resolveActor } = require('../middleware/resolveActor');

const ALLOWED_ROLES = new Set(['Owner', 'Manager', 'Employee']);
const MANAGE_STAFF_ROLES = new Set(['Owner', 'Manager']);

function createForbiddenError(message = 'Forbidden') {
  const error = new Error(message);
  error.status = 403;
  error.statusCode = 403;
  return error;
}

function requireManageStaff(actor) {
  if (!actor?.role || !MANAGE_STAFF_ROLES.has(actor.role)) {
    throw createForbiddenError();
  }
}

function canAssignRole(actor, targetRole) {
  if (targetRole === 'Employee') return true;
  if (targetRole === 'Manager') return actor?.role === 'Owner';
  if (targetRole === 'Owner') return actor?.role === 'Owner';
  return false;
}

function canManageTargetRole(actor, targetRole) {
  if (targetRole === 'Employee') return true;
  if (targetRole === 'Manager') return actor?.role === 'Owner';
  if (targetRole === 'Owner') return actor?.role === 'Owner';
  return false;
}

async function resolveStaffActor(pool, req) {
  const actor = await resolveActor(pool, req);
  requireManageStaff(actor);
  return actor;
}

function sendStaffError(req, res, error, reason) {
  const statusCode = Number(error?.statusCode || error?.status || 500);

  if (statusCode === 401) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (statusCode === 403) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.logEvent?.(
    'error',
    'staff_request_failed',
    { reason }
  );

  return res.status(500).json({
    error: 'Internal server error',
  });
}

function normalizeStaffRole(role) {
  if (!role || typeof role !== 'string') {
    return null;
  }

  const trimmed = role.trim();
  if (ALLOWED_ROLES.has(trimmed)) {
    return trimmed;
  }

  return null;
}

module.exports = function staffRoutes(pool, verifyToken, firebaseAdmin) {
  const router = express.Router();

  router.use(verifyToken);

  router.get('/', async (req, res) => {
    try {
      const actor = await resolveStaffActor(pool, req);
      const restaurantId = actor.restaurantId;

      const result = await pool.query(
        `
          SELECT
            id,
            name,
            role,
            active,
            created_at
          FROM users
          WHERE restaurant_id = $1
            AND role <> 'Customer'
          ORDER BY active DESC, name ASC NULLS LAST, created_at DESC
        `,
        [restaurantId]
      );

      res.json({ staff: result.rows });
    } catch (error) {
      sendStaffError(req, res, error, 'STAFF_LIST_FAILED');
    }
  });

  router.post('/', async (req, res) => {
    let actor;

    try {
      actor = await resolveStaffActor(pool, req);
    } catch (error) {
      return sendStaffError(req, res, error, 'STAFF_CREATE_FAILED');
    }

    const restaurantId = actor.restaurantId;

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const role = normalizeStaffRole(req.body?.role || 'Employee');
    const firebaseUid =
      typeof req.body?.firebase_uid === 'string' ? req.body.firebase_uid.trim() : '';

    if (!name) {
      return res.status(400).json({ error: 'Staff name is required' });
    }

    if (!firebaseUid) {
      return res.status(400).json({ error: 'Firebase UID is required' });
    }

    if (!role) {
      return res.status(400).json({ error: 'Invalid staff role' });
    }

    if (!canAssignRole(actor, role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const result = await pool.query(
        `
          INSERT INTO users (firebase_uid, restaurant_id, role, name, active)
          VALUES ($1, $2, $3, $4, true)
          RETURNING id, name, role, active, created_at
        `,
        [firebaseUid, restaurantId, role, name]
      );

      if (firebaseAdmin?.auth) {
        await firebaseAdmin.auth().setCustomUserClaims(firebaseUid, {
          role,
          restaurantId,
          staff_user_id: result.rows[0].id,
        });
      } else {
        req.logEvent?.(
          'warn',
          'staff_custom_claims_skipped',
          { reason: 'FIREBASE_ADMIN_UNAVAILABLE' }
        );
      }

      res.status(201).json({ staff: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Staff member already exists' });
      }

      sendStaffError(req, res, error, 'STAFF_CREATE_FAILED');
    }
  });

  router.patch('/:id', async (req, res) => {
    let actor;

    try {
      actor = await resolveStaffActor(pool, req);
    } catch (error) {
      return sendStaffError(req, res, error, 'STAFF_UPDATE_FAILED');
    }

    const restaurantId = actor.restaurantId;

    const staffId = req.params.id;
    const updates = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';

      if (!name) {
        return res.status(400).json({ error: 'Staff name cannot be empty' });
      }

      values.push(name);
      updates.push(`name = $${values.length}`);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'role')) {
      const role = normalizeStaffRole(req.body.role);

      if (!role) {
        return res.status(400).json({ error: 'Invalid staff role' });
      }

      if (!canAssignRole(actor, role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      values.push(role);
      updates.push(`role = $${values.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No staff updates provided' });
    }

    try {
      const targetResult = await pool.query(
        `
          SELECT id, role
          FROM users
          WHERE id = $1
            AND restaurant_id = $2
            AND role <> 'Customer'
          LIMIT 1
        `,
        [staffId, restaurantId]
      );

      if (targetResult.rowCount === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }

      const target = targetResult.rows[0];

      if (!canManageTargetRole(actor, target.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } catch (error) {
      return sendStaffError(req, res, error, 'STAFF_UPDATE_FAILED');
    }

    values.push(staffId);
    const staffIdIndex = values.length;
    values.push(restaurantId);
    const restaurantIdIndex = values.length;

    try {
      const result = await pool.query(
        `
          UPDATE users
          SET ${updates.join(', ')}
          WHERE id = $${staffIdIndex}
            AND restaurant_id = $${restaurantIdIndex}
          RETURNING id, name, role, active, created_at
        `,
        values
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }

      res.json({ staff: result.rows[0] });
    } catch (error) {
      sendStaffError(req, res, error, 'STAFF_UPDATE_FAILED');
    }
  });

  router.post('/:id/refresh-claims', async (req, res) => {
    let actor;

    try {
      actor = await resolveStaffActor(pool, req);
    } catch (error) {
      return sendStaffError(req, res, error, 'STAFF_CLAIMS_REFRESH_FAILED');
    }

    const restaurantId = actor.restaurantId;

    if (!firebaseAdmin?.auth) {
      return res.status(500).json({ error: 'Firebase Admin unavailable' });
    }

    try {
      const result = await pool.query(
        `
          SELECT
            id,
            firebase_uid,
            restaurant_id,
            role,
            name,
            active
          FROM users
          WHERE id = $1
            AND restaurant_id = $2
            AND role <> 'Customer'
        `,
        [req.params.id, restaurantId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }

      const staff = result.rows[0];

      if (!canManageTargetRole(actor, staff.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (!staff.firebase_uid) {
        return res.status(400).json({ error: 'Staff member is missing Firebase UID' });
      }

      await firebaseAdmin.auth().setCustomUserClaims(staff.firebase_uid, {
        role: staff.role,
        restaurantId: staff.restaurant_id,
        staff_user_id: staff.id,
      });

      res.json({
        staff: {
          id: staff.id,
          name: staff.name,
          role: staff.role,
          active: staff.active,
        },
        claimsRefreshed: true,
      });
    } catch (error) {
      sendStaffError(req, res, error, 'STAFF_CLAIMS_REFRESH_FAILED');
    }
  });

  router.patch('/:id/disable', async (req, res) => {
    let actor;

    try {
      actor = await resolveStaffActor(pool, req);
    } catch (error) {
      return sendStaffError(req, res, error, 'STAFF_DISABLE_FAILED');
    }

    const restaurantId = actor.restaurantId;

    if (req.params.id === actor.userId) {
      return res.status(403).json({ error: 'Cannot disable yourself' });
    }

    try {
      const result = await pool.query(
        `
          UPDATE users
          SET active = false
          WHERE id = $1
            AND restaurant_id = $2
            AND role <> 'Customer'
            AND ($3 = 'Owner' OR role <> 'Owner')
          RETURNING id, name, role, active, created_at
        `,
        [req.params.id, restaurantId, actor.role]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }

      res.json({ staff: result.rows[0] });
    } catch (error) {
      sendStaffError(req, res, error, 'STAFF_DISABLE_FAILED');
    }
  });

  router.patch('/:id/reactivate', async (req, res) => {
    let actor;

    try {
      actor = await resolveStaffActor(pool, req);
    } catch (error) {
      return sendStaffError(req, res, error, 'STAFF_REACTIVATE_FAILED');
    }

    const restaurantId = actor.restaurantId;

    try {
      const result = await pool.query(
        `
          UPDATE users
          SET active = true
          WHERE id = $1
            AND restaurant_id = $2
            AND role <> 'Customer'
            AND ($3 = 'Owner' OR role <> 'Owner')
          RETURNING id, name, role, active, created_at
        `,
        [req.params.id, restaurantId, actor.role]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Staff member not found' });
      }

      res.json({ staff: result.rows[0] });
    } catch (error) {
      sendStaffError(req, res, error, 'STAFF_REACTIVATE_FAILED');
    }
  });

  return router;
}