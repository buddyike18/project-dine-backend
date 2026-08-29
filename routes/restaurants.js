const express = require('express');
const {
  resolveActor,
  sendActorError,
} = require('../middleware/resolveActor');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(
    String(value || '').trim()
  );
}

module.exports = (pool, verifyToken) => {
  async function resolveManager(req, res) {
    try {
      const actor = await resolveActor(pool, req);

      if (actor.role !== 'Manager') {
        res.status(403).json({
          error: 'Access denied.',
        });
        return null;
      }

      return actor;
    } catch (err) {
      sendActorError(req, res, err);
      return null;
    }
  }

  router.get('/settings', verifyToken, async (req, res) => {
    const actor = await resolveManager(req, res);
    if (!actor) return;

    try {
      const result = await pool.query(
        `
          SELECT
            automatic_gratuity_enabled,
            automatic_gratuity_bps
          FROM public.restaurants
          WHERE id = $1
            AND active = TRUE
          LIMIT 1
        `,
        [actor.restaurantId]
      );

      const settings = result.rows[0];

      if (!settings) {
        return res.status(404).json({
          error: 'Restaurant not found',
        });
      }

      return res.json({
        automatic_gratuity_enabled:
          settings.automatic_gratuity_enabled === true,
        automatic_gratuity_bps:
          Number(settings.automatic_gratuity_bps || 0),
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'restaurant_settings_read_failed',
        {
          reason:
            err?.code ||
            err?.name ||
            'RESTAURANT_SETTINGS_READ_FAILED',
        }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  router.patch('/settings', verifyToken, async (req, res) => {
    const actor = await resolveManager(req, res);
    if (!actor) return;

    const {
      automatic_gratuity_enabled,
      automatic_gratuity_bps,
    } = req.body || {};

    if (typeof automatic_gratuity_enabled !== 'boolean') {
      return res.status(400).json({
        error: 'automatic_gratuity_enabled must be boolean',
      });
    }

    if (
      !Number.isInteger(automatic_gratuity_bps) ||
      automatic_gratuity_bps < 0 ||
      automatic_gratuity_bps > 5000
    ) {
      return res.status(400).json({
        error:
          'automatic_gratuity_bps must be an integer between 0 and 5000',
      });
    }

    try {
      const result = await pool.query(
        `
          UPDATE public.restaurants
          SET
            automatic_gratuity_enabled = $1,
            automatic_gratuity_bps = $2
          WHERE id = $3
            AND active = TRUE
          RETURNING
            automatic_gratuity_enabled,
            automatic_gratuity_bps
        `,
        [
          automatic_gratuity_enabled,
          automatic_gratuity_bps,
          actor.restaurantId,
        ]
      );

      const settings = result.rows[0];

      if (!settings) {
        return res.status(404).json({
          error: 'Restaurant not found',
        });
      }

      return res.json({
        automatic_gratuity_enabled:
          settings.automatic_gratuity_enabled === true,
        automatic_gratuity_bps:
          Number(settings.automatic_gratuity_bps || 0),
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'restaurant_settings_update_failed',
        {
          reason:
            err?.code ||
            err?.name ||
            'RESTAURANT_SETTINGS_UPDATE_FAILED',
        }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  // Public restaurant metadata read.
  // Returns only safe customer-facing fields.
  router.get('/:restaurantId', async (req, res) => {
    const restaurantId =
      String(
        req.params.restaurantId || ''
      ).trim();

    if (!isUuid(restaurantId)) {
      return res.status(400).json({
        error: 'Invalid restaurant id',
      });
    }

    try {
      const result = await pool.query(
        `
          SELECT
            id,
            name
          FROM public.restaurants
          WHERE id = $1
            AND active = TRUE
          LIMIT 1
        `,
        [restaurantId]
      );

      const restaurant =
        result.rows[0];

      if (!restaurant) {
        return res.status(404).json({
          error: 'Restaurant not found',
        });
      }

      return res.json({
        id: restaurant.id,
        name: restaurant.name,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'restaurant_metadata_request_failed',
        {
          reason:
            err?.code ||
            err?.name ||
            'RESTAURANT_METADATA_READ_FAILED',
        }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  return router;
};
