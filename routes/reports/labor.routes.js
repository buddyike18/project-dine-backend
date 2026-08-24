/**
 * Phase 8.3 — Labor vs Sales Reporting Routes
 *
 * JSON (non-CSV) reporting endpoints derived from shifts + orders.
 * RBAC is enforced by the parent reports router.
 */

const express = require('express');
const {
  requireRestaurantScope,
  parseTz,
  parseDayRange,
  parseTimeRange,
  sendError,
} = require('./reportUtils');

module.exports = (pool, reportsQueries) => {
  const router = express.Router();

  /**
   * GET /api/reports/labor-vs-sales/daily
   *
   * Query params:
   *  - start_date (YYYY-MM-DD, inclusive)
   *  - end_date   (YYYY-MM-DD, inclusive)
   *  - tz         (optional, defaults to UTC)
   */
  router.get('/daily', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const dayRange = parseDayRange(req);
      if (!dayRange.ok) return sendError(res, dayRange);

      const tzParsed = parseTz(req);
      if (!tzParsed.ok) return sendError(res, tzParsed);

      const { restaurantId } = scope;
      const { start_date, end_date } = dayRange;
      const { tz } = tzParsed;

      const {
        rows: [{ report_end }]
      } = await pool.query(
        `SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) AS report_end`,
        [end_date, tz]
      );

      const { rows } = await pool.query(
        reportsQueries.laborVsSalesDaily,
        [restaurantId, start_date, tz, end_date, report_end]
      );

      return res.json({
        definition: {
          labor_definition:
            'sum(shifts.duration_minutes) else derived from (clock_out_at - clock_in_at); open shifts are capped at the deterministic report end',
          sales_definition: 'sum(orders.total_cents) for CLOSED orders',
          attribution_rule:
            'sales are bucketed by closed_at date; labor by shift clock_in_at date',
          timezone: tz,
          date_range: { start_date, end_date },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'labor_report_failed',
        { reason: 'LABOR_DAILY_REPORT_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/labor-vs-sales/shifts
   *
   * Query params:
   *  - start (ISO timestamp, inclusive)
   *  - end   (ISO timestamp, exclusive)
   */
  router.get('/shifts', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const { rows } = await pool.query(
        reportsQueries.laborVsSalesByShift,
        [restaurantId, start, end]
      );

      return res.json({
        definition: {
          labor_definition:
            'shift duration_minutes else derived from (clock_out_at - clock_in_at); open shifts are capped at the deterministic report end',
          sales_definition: 'sum(orders.total_cents) for CLOSED orders',
          attribution_rule: 'orders closed during each shift window',
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'labor_report_failed',
        { reason: 'LABOR_SHIFT_REPORT_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/labor-vs-sales/by-employee
   *
   * Query params:
   *  - start (ISO timestamp, inclusive)
   *  - end   (ISO timestamp, exclusive)
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
        reportsQueries.laborVsSalesByEmployee,
        [restaurantId, start, end]
      );

      return res.json({
        definition: {
          labor_definition:
            "aggregated from shifts in window; duration_minutes else derived from (clock_out_at - clock_in_at); open shifts are capped at the deterministic report end",
          sales_definition: 'sum(orders.total_cents) for CLOSED orders',
          attribution_rule:
            "sales are attributed to an employee's shift windows (orders closed during each shift)",
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'labor_report_failed',
        { reason: 'LABOR_EMPLOYEE_REPORT_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  return router;
};
