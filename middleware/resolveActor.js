'use strict';

const ALLOWED_ROLES = new Set(['Manager', 'Employee', 'Customer']);

function createActorError(message, statusCode) {
  const error = new Error(message);
  error.status = statusCode;
  error.statusCode = statusCode;
  return error;
}

function normalizeRole(role) {
  const value = String(role || '').trim();
  const lower = value.toLowerCase();
  if (lower === 'manager') return 'Manager';
  if (lower === 'employee' || lower === 'staff') return 'Employee';
  if (lower === 'customer') return 'Customer';

  return null;
}

function readActiveFlag(userRow) {
  if (!userRow) return false;

  const rawActive = Object.prototype.hasOwnProperty.call(userRow, 'active')
    ? userRow.active
    : userRow.is_active;

  if (typeof rawActive === 'boolean') return rawActive === true;
  if (typeof rawActive === 'number') return rawActive === 1;
  if (typeof rawActive === 'string') {
    const normalized = rawActive.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  return false;
}

async function resolveActor(pool, req) {
  const firebaseUid = req.user?.uid || req.user?.firebase_uid || req.user?.firebaseUid;

  if (!firebaseUid) {
    throw createActorError('Authenticated Firebase UID is required.', 401);
  }

  const result = await pool.query(
    `SELECT id, firebase_uid, restaurant_id, role, active
       FROM users
      WHERE firebase_uid = $1
      LIMIT 1`,
    [firebaseUid]
  );

  const user = result.rows[0];

  if (!user) {
    throw createActorError('Authenticated user is not registered.', 403);
  }

  if (!user.restaurant_id) {
    throw createActorError('Authenticated user is missing restaurant scope.', 403);
  }

  const role = normalizeRole(user.role);

  if (!role || !ALLOWED_ROLES.has(role)) {
    throw createActorError('Authenticated user has invalid role.', 403);
  }

  const active = readActiveFlag(user);

  if (active !== true) {
    throw createActorError('Authenticated user is inactive.', 403);
  }

  return {
    userId: user.id,
    firebaseUid: user.firebase_uid,
    restaurantId: user.restaurant_id,
    role,
    active,
  };
}

function sendActorError(req, res, error) {
  const statusCode =
    error?.statusCode === 401 || error?.status === 401
      ? 401
      : error?.statusCode === 403 || error?.status === 403
        ? 403
        : 500;

  const reason =
    statusCode === 401
      ? 'missing_authenticated_identity'
      : statusCode === 403
        ? 'actor_not_authorized'
        : 'actor_resolution_internal_error';

  if (req?.logEvent) {
    req.logEvent(
      statusCode >= 500 ? 'error' : 'warn',
      'actor_resolution_failed',
      {
        statusCode,
        reason,
      }
    );
  }

  const clientMessage =
    statusCode === 401
      ? 'Authentication required.'
      : statusCode === 403
        ? 'Access denied.'
        : 'Unable to resolve authenticated user.';

  return res.status(statusCode).json({ error: clientMessage });
}

module.exports = {
  normalizeRole,
  resolveActor,
  sendActorError,
};