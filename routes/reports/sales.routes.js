/**
 * Phase 8.1 — Sales Reporting Routes
 *
 * This router contains JSON (non-CSV) sales reporting endpoints only.
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
   * GET /api/reports/sales
   */
  router.get('/', async (req, res) => {
    try {
      const restaurantScope = requireRestaurantScope(req);
      if (!restaurantScope.ok) return sendError(res, restaurantScope);
      const timeRange = parseTimeRange(req);
      if (!timeRange.ok) return sendError(res, timeRange);

      const restaurantId = restaurantScope.restaurantId;
      const { start, end } = timeRange;

      const { rows } = await pool.query(
        reportsQueries.salesBaseline,
        [restaurantId, start, end]
      );

      const summary = rows[0] || {
        total_orders: 0,
        total_revenue: 0,
        total_comped_amount: 0,
        total_voided_orders: 0,
        net_revenue: 0,
      };

      return res.json({
        definition: {
          revenue_definition: 'sum(orders.paid_cents) for paid orders only',
          comp_definition: 'deduped ORDER_COMPED events from order_events',
          void_definition: 'deduped ORDER_VOIDED events from order_events',
          net_revenue_definition: 'total_revenue - total_comped_amount',
          time_window: { start, end },
        },
        summary,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'sales_report_failed',
        { reason: 'SALES_REPORT_SUMMARY_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/sales/daily
   */
  router.get('/daily', async (req, res) => {
    try {
      const restaurantScope = requireRestaurantScope(req);
      if (!restaurantScope.ok) return sendError(res, restaurantScope);
      const dayRange = parseDayRange(req);
      if (!dayRange.ok) return sendError(res, dayRange);
      const tzParsed = parseTz(req);
      if (!tzParsed.ok) return sendError(res, tzParsed);

      const restaurantId = restaurantScope.restaurantId;
      const { start_date, end_date } = dayRange;
      const tz = tzParsed.tz;

      const { rows } = await pool.query(
        reportsQueries.dailySalesSummary,
        [restaurantId, start_date, tz, end_date]
      );

      return res.json({
        definition: {
          sales_definition: 'sum(orders.total_cents) for CLOSED orders',
          closed_definition: 'status=CLOSED and closed_at IS NOT NULL',
          timezone: tz,
          date_range: { start_date, end_date },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'sales_report_failed',
        { reason: 'SALES_REPORT_DAILY_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/sales/status
   */
  router.get('/status', async (req, res) => {
    try {
      const restaurantScope = requireRestaurantScope(req);
      if (!restaurantScope.ok) return sendError(res, restaurantScope);
      const timeRange = parseTimeRange(req);
      if (!timeRange.ok) return sendError(res, timeRange);

      const restaurantId = restaurantScope.restaurantId;
      const { start, end } = timeRange;

      const { rows } = await pool.query(
        reportsQueries.statusBreakdown,
        [restaurantId, start, end]
      );

      return res.json({
        definition: {
          status_definition: 'count of orders by status',
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'sales_report_failed',
        { reason: 'SALES_REPORT_STATUS_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * GET /api/reports/sales/shifts
   */
  router.get('/shifts', async (req, res) => {
    try {
      const restaurantScope = requireRestaurantScope(req);
      if (!restaurantScope.ok) return sendError(res, restaurantScope);
      const timeRange = parseTimeRange(req);
      if (!timeRange.ok) return sendError(res, timeRange);

      const restaurantId = restaurantScope.restaurantId;
      const { start, end } = timeRange;

      const { rows } = await pool.query(
        reportsQueries.shiftSalesSummary,
        [restaurantId, start, end]
      );

      return res.json({
        definition: {
          attribution_rule: 'orders closed during shift window',
          time_window: { start, end },
        },
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'sales_report_failed',
        { reason: 'SALES_REPORT_SHIFTS_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  return router;
};