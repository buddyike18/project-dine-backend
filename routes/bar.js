'use strict';

const express = require('express');
const {
  resolveActor,
  sendActorError,
} = require('../middleware/resolveActor');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STAFF_ROLES = new Set(['Manager', 'Employee']);
const CHECK_STATUSES = new Set(['OPEN', 'CLOSED', 'VOIDED']);

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function requireStaff(actor) {
  if (!STAFF_ROLES.has(actor.role)) {
    const error = new Error('Staff access required.');
    error.status = 403;
    error.statusCode = 403;
    throw error;
  }
}

function normalizeDisplayName(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const normalized = String(value).trim();
  if (!normalized || normalized.length > 120) {
    const error = new Error('display_name must be between 1 and 120 characters.');
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function sendRequestError(req, res, error, eventName) {
  const statusCode =
    [400, 401, 403, 404, 409].includes(error?.statusCode)
      ? error.statusCode
      : [400, 401, 403, 404, 409].includes(error?.status)
        ? error.status
        : 500;

  if (statusCode === 401 || statusCode === 403) {
    return sendActorError(req, res, error);
  }

  req.logEvent?.(
    statusCode >= 500 ? 'error' : 'warn',
    eventName,
    {
      statusCode,
      reason: error?.message || 'unknown_error',
    }
  );

  if (statusCode >= 500) {
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(statusCode).json({ error: error.message });
}

module.exports = function barRoutes(pool, verifyToken) {
  const router = express.Router();

  router.get('/chairs', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const result = await pool.query(
        `SELECT
           id,
           chair_number,
           display_name,
           active,
           created_at,
           updated_at
         FROM bar_chairs
         WHERE restaurant_id = $1
         ORDER BY chair_number ASC`,
        [actor.restaurantId]
      );

      return res.json({ chairs: result.rows });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_chairs_list_failed');
    }
  });

  router.post('/chairs', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      if (actor.role !== 'Manager') {
        const error = new Error('Manager access required.');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }

      const chairNumber = Number(req.body?.chair_number);
      if (!Number.isInteger(chairNumber) || chairNumber <= 0) {
        const error = new Error('chair_number must be a positive integer.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);

      const result = await pool.query(
        `INSERT INTO bar_chairs (
           restaurant_id,
           chair_number,
           display_name
         )
         VALUES ($1, $2, $3)
         RETURNING
           id,
           chair_number,
           display_name,
           active,
           created_at,
           updated_at`,
        [actor.restaurantId, chairNumber, displayName ?? null]
      );

      return res.status(201).json({ chair: result.rows[0] });
    } catch (error) {
      if (error?.code === '23505') {
        error.status = 409;
        error.statusCode = 409;
        error.message = 'A bar chair with that number already exists.';
      }

      return sendRequestError(req, res, error, 'bar_chair_create_failed');
    }
  });

  router.patch('/chairs/:chairId', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      if (actor.role !== 'Manager') {
        const error = new Error('Manager access required.');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }

      const chairId = String(req.params.chairId || '').trim();
      if (!isUuid(chairId)) {
        const error = new Error('Invalid chair ID.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);
      const active =
        req.body?.active === undefined
          ? undefined
          : req.body.active;

      if (
        active !== undefined &&
        typeof active !== 'boolean'
      ) {
        const error = new Error('active must be a boolean.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      if (displayName === undefined && active === undefined) {
        const error = new Error('No supported chair fields were provided.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const result = await pool.query(
        `UPDATE bar_chairs
         SET
           display_name = COALESCE($3, display_name),
           active = COALESCE($4, active)
         WHERE id = $1
           AND restaurant_id = $2
         RETURNING
           id,
           chair_number,
           display_name,
           active,
           created_at,
           updated_at`,
        [
          chairId,
          actor.restaurantId,
          displayName === undefined ? null : displayName,
          active === undefined ? null : active,
        ]
      );

      if (result.rowCount !== 1) {
        const error = new Error('Bar chair not found.');
        error.status = 404;
        error.statusCode = 404;
        throw error;
      }

      return res.json({ chair: result.rows[0] });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_chair_update_failed');
    }
  });

  router.get('/checks', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const status =
        req.query?.status === undefined
          ? 'OPEN'
          : String(req.query.status).trim().toUpperCase();

      if (!CHECK_STATUSES.has(status)) {
        const error = new Error('Invalid check status.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const result = await pool.query(
        `SELECT
           c.id,
           c.bar_chair_id,
           bc.chair_number,
           bc.display_name AS chair_display_name,
           c.opened_by_user_id,
           c.closed_by_user_id,
           c.display_name,
           c.status,
           c.opened_at,
           c.closed_at,
           c.created_at,
           c.updated_at
         FROM checks c
         LEFT JOIN bar_chairs bc
           ON bc.id = c.bar_chair_id
          AND bc.restaurant_id = c.restaurant_id
         WHERE c.restaurant_id = $1
           AND c.status = $2
         ORDER BY c.opened_at ASC`,
        [actor.restaurantId, status]
      );

      return res.json({ checks: result.rows });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_checks_list_failed');
    }
  });

  router.post('/checks', verifyToken, async (req, res) => {
    let client;

    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const barChairId =
        req.body?.bar_chair_id === undefined ||
        req.body?.bar_chair_id === null
          ? null
          : String(req.body.bar_chair_id).trim();

      if (barChairId !== null && !isUuid(barChairId)) {
        const error = new Error('Invalid bar_chair_id.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);

      client = await pool.connect();
      await client.query('BEGIN');

      if (barChairId !== null) {
        const chair = await client.query(
          `SELECT id, active
           FROM bar_chairs
           WHERE id = $1
             AND restaurant_id = $2
           FOR UPDATE`,
          [barChairId, actor.restaurantId]
        );

        if (chair.rowCount !== 1) {
          const error = new Error('Bar chair not found.');
          error.status = 404;
          error.statusCode = 404;
          throw error;
        }

        if (chair.rows[0].active !== true) {
          const error = new Error('Bar chair is inactive.');
          error.status = 409;
          error.statusCode = 409;
          throw error;
        }
      }

      const result = await client.query(
        `INSERT INTO checks (
           restaurant_id,
           bar_chair_id,
           opened_by_user_id,
           display_name
         )
         VALUES ($1, $2, $3, $4)
         RETURNING
           id,
           bar_chair_id,
           opened_by_user_id,
           closed_by_user_id,
           display_name,
           status,
           opened_at,
           closed_at,
           created_at,
           updated_at`,
        [
          actor.restaurantId,
          barChairId,
          actor.userId,
          displayName ?? null,
        ]
      );

      await client.query('COMMIT');
      return res.status(201).json({ check: result.rows[0] });
    } catch (error) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }

      if (
        error?.code === '23505' &&
        error?.constraint === 'uq_checks_one_open_per_bar_chair'
      ) {
        error.status = 409;
        error.statusCode = 409;
        error.message = 'That bar chair already has an open check.';
      }

      return sendRequestError(req, res, error, 'bar_check_create_failed');
    } finally {
      client?.release();
    }
  });

  router.get('/checks/:checkId', verifyToken, async (req, res) => {
    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const checkId = String(req.params.checkId || '').trim();
      if (!isUuid(checkId)) {
        const error = new Error('Invalid check ID.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const result = await pool.query(
        `SELECT
           c.id,
           c.bar_chair_id,
           bc.chair_number,
           bc.display_name AS chair_display_name,
           c.opened_by_user_id,
           c.closed_by_user_id,
           c.display_name,
           c.status,
           c.opened_at,
           c.closed_at,
           c.created_at,
           c.updated_at
         FROM checks c
         LEFT JOIN bar_chairs bc
           ON bc.id = c.bar_chair_id
          AND bc.restaurant_id = c.restaurant_id
         WHERE c.id = $1
           AND c.restaurant_id = $2
         LIMIT 1`,
        [checkId, actor.restaurantId]
      );

      if (result.rowCount !== 1) {
        const error = new Error('Check not found.');
        error.status = 404;
        error.statusCode = 404;
        throw error;
      }

      return res.json({ check: result.rows[0] });
    } catch (error) {
      return sendRequestError(req, res, error, 'bar_check_read_failed');
    }
  });

  router.patch('/checks/:checkId', verifyToken, async (req, res) => {
    let client;

    try {
      const actor = await resolveActor(pool, req);
      requireStaff(actor);

      const checkId = String(req.params.checkId || '').trim();
      if (!isUuid(checkId)) {
        const error = new Error('Invalid check ID.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      const displayName = normalizeDisplayName(req.body?.display_name);
      const barChairId =
        req.body?.bar_chair_id === undefined
          ? undefined
          : req.body.bar_chair_id === null
            ? null
            : String(req.body.bar_chair_id).trim();

      if (
        barChairId !== undefined &&
        barChairId !== null &&
        !isUuid(barChairId)
      ) {
        const error = new Error('Invalid bar_chair_id.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      if (displayName === undefined && barChairId === undefined) {
        const error = new Error('No supported check fields were provided.');
        error.status = 400;
        error.statusCode = 400;
        throw error;
      }

      client = await pool.connect();
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id, status
         FROM checks
         WHERE id = $1
           AND restaurant_id = $2
         FOR UPDATE`,
        [checkId, actor.restaurantId]
      );

      if (existing.rowCount !== 1) {
        const error = new Error('Check not found.');
        error.status = 404;
        error.statusCode = 404;
        throw error;
      }

      if (existing.rows[0].status !== 'OPEN') {
        const error = new Error('Only open checks can be updated.');
        error.status = 409;
        error.statusCode = 409;
        throw error;
      }

      if (barChairId !== undefined && barChairId !== null) {
        const chair = await client.query(
          `SELECT id, active
           FROM bar_chairs
           WHERE id = $1
             AND restaurant_id = $2
           FOR UPDATE`,
          [barChairId, actor.restaurantId]
        );

        if (chair.rowCount !== 1) {
          const error = new Error('Bar chair not found.');
          error.status = 404;
          error.statusCode = 404;
          throw error;
        }

        if (chair.rows[0].active !== true) {
          const error = new Error('Bar chair is inactive.');
          error.status = 409;
          error.statusCode = 409;
          throw error;
        }
      }

      const result = await client.query(
        `UPDATE checks
         SET
           display_name = CASE
             WHEN $3::boolean THEN $4
             ELSE display_name
           END,
           bar_chair_id = CASE
             WHEN $5::boolean THEN $6
             ELSE bar_chair_id
           END
         WHERE id = $1
           AND restaurant_id = $2
         RETURNING
           id,
           bar_chair_id,
           opened_by_user_id,
           closed_by_user_id,
           display_name,
           status,
           opened_at,
           closed_at,
           created_at,
           updated_at`,
        [
          checkId,
          actor.restaurantId,
          displayName !== undefined,
          displayName ?? null,
          barChairId !== undefined,
          barChairId ?? null,
        ]
      );

      await client.query('COMMIT');
      return res.json({ check: result.rows[0] });
    } catch (error) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }

      if (
        error?.code === '23505' &&
        error?.constraint === 'uq_checks_one_open_per_bar_chair'
      ) {
        error.status = 409;
        error.statusCode = 409;
        error.message = 'That bar chair already has an open check.';
      }

      return sendRequestError(req, res, error, 'bar_check_update_failed');
    } finally {
      client?.release();
    }
  });

  return router;
};
