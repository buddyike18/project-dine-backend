const express = require('express');
const { resolveActor } = require('../middleware/resolveActor');

const reportsQueries = require('./reports/reports.queries');

const salesRoutes = require('./reports/sales.routes');
const voidsCompsRoutes = require('./reports/voidsComps.routes');
const laborRoutes = require('./reports/labor.routes');
const exportsRoutes = require('./reports/exports.routes');

const REPORT_MANAGER_ROLES = new Set(['Owner', 'Manager']);

function requireReportManager(pool) {
  return async (req, res, next) => {
    try {
      const actor = await resolveActor(pool, req);

      if (!REPORT_MANAGER_ROLES.has(actor.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (!actor.restaurantId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      req.actor = actor;
      return next();
    } catch (error) {
      if (error.statusCode === 401 || error.status === 401) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (error.statusCode === 403 || error.status === 403) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      req.logEvent?.(
        'error',
        'report_authorization_failed',
        {
          reason:
            'REPORT_ACTOR_RESOLUTION_FAILED',
        }
      );

      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  };
}

/**
 * Phase 8 — Reporting & Analytics
 * Manager / Owner only
 *
 * This router exposes backend-authoritative reporting endpoints.
 * No POS, KDS, or customer workflows are permitted here.
 */
module.exports = (pool, verifyToken) => {
  const router = express.Router();

  // Enforce DB-backed manager / owner access for all reports
  router.use(verifyToken);
  router.use(requireReportManager(pool));

  // Phase 8.1 — Core Sales Reporting (JSON)
  router.use('/sales', salesRoutes(pool, reportsQueries));

  // Phase 8.2 — Void & Comp Reporting (JSON)
  router.use('/voids-comps', voidsCompsRoutes(pool, reportsQueries));
  // Phase 29 — Overrides Baseline (alias for voids/comps)
  router.use('/overrides', voidsCompsRoutes(pool, reportsQueries));

  // Phase 8.3 — Labor vs Sales (JSON)
  router.use('/labor-vs-sales', laborRoutes(pool, reportsQueries));

  // Phase 8.4 — Exports & Auditability (CSV)
  router.use('/exports', exportsRoutes(pool, reportsQueries));

  return router;
};
