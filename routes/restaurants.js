const express = require('express');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(
    String(value || '').trim()
  );
}

module.exports = (pool) => {
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
