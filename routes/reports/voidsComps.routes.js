/**
 * Phase 8.2 — Voids & Comps Reporting Routes
 *
 * JSON (non-CSV) reporting endpoints sourced exclusively from order_events.
 * RBAC is enforced by the parent reports router.
 */

const express = require('express');
const {
  requireRestaurantScope,
  parseTz,
  parseTimeRange,
  parsePagination,
  sendError,
} = require('./reportUtils');

module.exports = (pool, reportsQueries) => {
  const router = express.Router();

  /**
   * GET /api/reports/overrides
   */
  router.get('/', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const { rows } = await pool.query(
        reportsQueries.overridesBaseline,
        [restaurantId, start, end]
      );

      const summary = rows[0] || {
        total_comps: 0,
        total_voids: 0,
        comped_amount: 0,
        comp_events: [],
        void_events: [],
      };

      return res.json({
        definition: {
          comp_definition: 'deduped ORDER_COMPED events from order_events',
          void_definition: 'deduped ORDER_VOIDED events from order_events',
          amount_rule: 'metadata.amount_cents else orders.paid_cents else orders.total_cents',
          time_window: { start, end },
        },
        summary,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'voids_comps_report_failed',
        { reason: 'VOIDS_COMPS_OVERRIDES_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/voids-comps/summary
   */
  router.get('/summary', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const { rows } = await pool.query(
        reportsQueries.voidsCompsSummary,
        [restaurantId, start, end]
      );

      return res.json({
        definition: {
          event_types: ['ORDER_VOIDED', 'ORDER_COMPED'],
          reason_source: "order_events.meta.reason (default 'UNSPECIFIED')",
          amount_rule: "meta.amount_cents else orders.total_cents (flagged as inferred)",
          time_window: { start, end },
        },
        row: rows[0] || null,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'voids_comps_report_failed',
        { reason: 'VOIDS_COMPS_SUMMARY_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/voids-comps/by-employee
   */
  router.get('/by-employee', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const { rows } = await pool.query(
        reportsQueries.voidsCompsByEmployee,
        [restaurantId, start, end]
      );

      return res.json({
        definition: {
          event_types: ['ORDER_VOIDED', 'ORDER_COMPED'],
          amount_rule: "meta.amount_cents else orders.total_cents (flagged as inferred)",
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'voids_comps_report_failed',
        { reason: 'VOIDS_COMPS_BY_EMPLOYEE_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/voids-comps/by-reason
   */
  router.get('/by-reason', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const { rows } = await pool.query(
        reportsQueries.voidsCompsByReason,
        [restaurantId, start, end]
      );

      return res.json({
        definition: {
          event_types: ['ORDER_VOIDED', 'ORDER_COMPED'],
          reason_source: "order_events.meta.reason (default 'UNSPECIFIED')",
          amount_rule: "meta.amount_cents else orders.total_cents (flagged as inferred)",
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'voids_comps_report_failed',
        { reason: 'VOIDS_COMPS_BY_REASON_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/voids-comps/timeseries
   */
  router.get('/timeseries', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const tzParsed = parseTz(req);
      if (!tzParsed.ok) return sendError(res, tzParsed);

      const bucket = (req.query.bucket || 'day').toString();
      const { restaurantId } = scope;
      const { start, end } = range;
      const { tz } = tzParsed;

      if (!['hour', 'day'].includes(bucket)) {
        return res.status(400).json({
          error: "bucket must be 'hour' or 'day'",
        });
      }

      const { rows } = await pool.query(
        reportsQueries.voidsCompsTimeseries,
        [restaurantId, start, end, bucket, tz]
      );

      return res.json({
        definition: {
          event_types: ['ORDER_VOIDED', 'ORDER_COMPED'],
          bucket,
          timezone: tz,
          amount_rule: "meta.amount_cents else orders.total_cents (flagged as inferred)",
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'voids_comps_report_failed',
        { reason: 'VOIDS_COMPS_TIMESERIES_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/voids-comps/line-items
   */
  router.get('/line-items', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const paging = parsePagination(req, { defaultLimit: 50, maxLimit: 500 });
      const { restaurantId } = scope;
      const { start, end } = range;
      const { limit, offset } = paging;

      const { rows } = await pool.query(
        reportsQueries.voidsCompsLineItems,
        [restaurantId, start, end, limit, offset]
      );

      return res.json({
        definition: {
          event_types: ['ORDER_VOIDED', 'ORDER_COMPED'],
          reason_source: "order_events.meta.reason (default 'UNSPECIFIED')",
          amount_rule: "meta.amount_cents else orders.total_cents (flagged as inferred)",
          paging: { limit, offset },
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'voids_comps_report_failed',
        { reason: 'VOIDS_COMPS_LINE_ITEMS_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  return router;
};
