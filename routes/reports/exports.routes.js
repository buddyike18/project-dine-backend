/**
 * Phase 8.4 — CSV Export Routes
 *
 * Thin routing layer that maps export endpoints to existing report queries
 * and CSV helpers. RBAC is enforced by the parent reports router.
 */

const express = require('express');
const {
  toMetaHeader,
  toCsv,
  setDownloadHeaders,
} = require('./exports');
const {
  requireRestaurantScope,
  parseTz,
  parseDayRange,
  parseTimeRange,
  sendError,
} = require('./reportUtils');

module.exports = (pool, reportsQueries) => {
  const router = express.Router();

  const sendCsv = ({ res, filename, meta, headers, rows }) => {
    setDownloadHeaders(res, filename);
    const metaBlock = toMetaHeader(meta);
    const csvBody = toCsv({ headers, rows });
    return res.status(200).send(metaBlock + csvBody);
  };

  const toFilenamePart = (value) =>
    String(value).replace(/[^A-Za-z0-9._-]+/g, '-');

  const MAX_DAY_EXPORT_DAYS = 366;
  const MAX_TIME_EXPORT_MS = 31 * 24 * 60 * 60 * 1000;

  const validateDayExportRange = (startDate, endDate) => {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);

    const days = Math.floor((end - start) / 86400000) + 1;

    if (days > MAX_DAY_EXPORT_DAYS) {
      return {
        ok: false,
        status: 400,
        error: `Export date range cannot exceed ${MAX_DAY_EXPORT_DAYS} days`,
      };
    }

    return { ok: true };
  };

  const validateTimeExportRange = (start, end) => {
    const duration = new Date(end) - new Date(start);

    if (duration > MAX_TIME_EXPORT_MS) {
      return {
        ok: false,
        status: 400,
        error: 'Export time range cannot exceed 31 days',
      };
    }

    return { ok: true };
  };


  /**
   * SALES EXPORTS
   */

  router.get('/sales/daily.csv', async (req, res) => {
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

      const rangeCheck = validateDayExportRange(start_date, end_date);
      if (!rangeCheck.ok) return sendError(res, rangeCheck);




      const { rows } = await pool.query(
        reportsQueries.dailySalesSummary,
        [restaurantId, start_date, tz, end_date]
      );

      return sendCsv({
        res,
        filename: `dine_sales_daily_${start_date}_${end_date}.csv`,
        meta: {
          phase: '8.4',
          report: 'sales_daily',
          sales_definition: 'sum(orders.total_cents) for CLOSED orders',
          closed_definition: 'status=CLOSED and closed_at IS NOT NULL',
          timezone: tz,
          date_range: { start_date, end_date },
        },
        headers: [
          'day',
          'closed_order_count',
          'open_order_count',
          'gross_sales_cents',
          'avg_ticket_cents',
          'tax_cents_sum',
          'tip_cents_sum',
        ],
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'report_export_failed',
        { reason: 'EXPORT_SALES_DAILY_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  router.get('/sales/status.csv', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const rangeCheck = validateTimeExportRange(start, end);
      if (!rangeCheck.ok) return sendError(res, rangeCheck);





      const { rows } = await pool.query(
        reportsQueries.statusBreakdown,
        [restaurantId, start, end]
      );

      return sendCsv({
        res,
        filename: `dine_sales_status_${toFilenamePart(start)}_${toFilenamePart(end)}.csv`,
        meta: {
          phase: '8.4',
          report: 'sales_status',
          status_definition: 'count of orders by status',
          time_window: { start, end },
        },
        headers: ['status', 'order_count'],
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'report_export_failed',
        { reason: 'EXPORT_SALES_STATUS_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  router.get('/sales/shifts.csv', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const rangeCheck = validateTimeExportRange(start, end);
      if (!rangeCheck.ok) return sendError(res, rangeCheck);


      const { rows } = await pool.query(
        reportsQueries.shiftSalesSummary,
        [restaurantId, start, end]
      );

      return sendCsv({
        res,
        filename: `dine_sales_shifts_${toFilenamePart(start)}_${toFilenamePart(end)}.csv`,
        meta: {
          phase: '8.4',
          report: 'sales_shifts',
          attribution_rule: 'orders closed during shift window',
          time_window: { start, end },
        },
        headers: [
          'shift_id',
          'user_id',
          'clock_in_at',
          'clock_out_at',
          'duration_minutes',
          'closed_order_count',
          'gross_sales_cents',
          'avg_ticket_cents',
        ],
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'report_export_failed',
        { reason: 'EXPORT_SALES_SHIFTS_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * VOIDS & COMPS EXPORTS
   */

  router.get('/voids-comps/summary.csv', async (req, res) => {
    try {
      const scope = requireRestaurantScope(req);
      if (!scope.ok) return sendError(res, scope);

      const range = parseTimeRange(req);
      if (!range.ok) return sendError(res, range);

      const { restaurantId } = scope;
      const { start, end } = range;

      const rangeCheck = validateTimeExportRange(start, end);
      if (!rangeCheck.ok) return sendError(res, rangeCheck);


      const { rows } = await pool.query(
        reportsQueries.voidsCompsSummary,
        [restaurantId, start, end]
      );

      return sendCsv({
        res,
        filename: `dine_voids_comps_summary_${toFilenamePart(start)}_${toFilenamePart(end)}.csv`,
        meta: {
          phase: '8.4',
          report: 'voids_comps_summary',
          event_types: ['ORDER_VOIDED', 'ORDER_COMPED'],
          time_window: { start, end },
        },
        headers: [
          'void_count',
          'void_amount_cents',
          'comp_count',
          'comp_amount_cents',
          'total_impact_cents',
          'inferred_amount_count',
          'unknown_actor_count',
        ],
        rows: [rows[0] || {}],
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'report_export_failed',
        { reason: 'EXPORT_VOIDS_COMPS_SUMMARY_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  /**
   * LABOR VS SALES EXPORTS
   */

  router.get('/labor-vs-sales/daily.csv', async (req, res) => {
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

      const rangeCheck = validateDayExportRange(start_date, end_date);
      if (!rangeCheck.ok) return sendError(res, rangeCheck);


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

      return sendCsv({
        res,
        filename: `dine_labor_vs_sales_daily_${start_date}_${end_date}.csv`,
        meta: {
          phase: '8.4',
          report: 'labor_vs_sales_daily',
          timezone: tz,
          date_range: { start_date, end_date },
        },
        headers: [
          'day',
          'shifts_count',
          'incomplete_shifts_count',
          'labor_minutes_total',
          'labor_hours_total',
          'closed_order_count',
          'gross_sales_cents',
          'sales_per_labor_hour_cents',
        ],
        rows,
      });
    } catch (err) {
      req.logEvent?.(
        'error',
        'report_export_failed',
        { reason: 'EXPORT_LABOR_VS_SALES_DAILY_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  });

  return router;
};