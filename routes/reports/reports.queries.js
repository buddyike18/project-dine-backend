/**
 * Phase 8 — Reporting & Analytics
 * SQL-only query layer for backend-authoritative reports.
 *
 * IMPORTANT:
 * - No business logic
 * - No role checks
 * - No request/response handling
 * - Queries must be deterministic and reproducible from raw data
 */

module.exports = {
  /**
   * Phase 29 — Sales Baseline
   *
   * Backend-authoritative financial baseline for overview reporting.
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   *
   * Time window uses orders.opened_at because this schema does not use orders.created_at.
   */
  salesBaseline: `
    WITH paid_orders AS (
      SELECT
        o.id,
        COALESCE(o.paid_cents, 0) AS paid_cents,
        COALESCE(o.total_cents, 0) AS total_cents
      FROM orders o
      WHERE o.restaurant_id = $1
        AND o.opened_at >= $2
        AND o.opened_at < $3
        AND COALESCE(o.paid_cents, 0) > 0
    ),
    comped_orders AS (
      SELECT DISTINCT ON (oe.order_id)
        oe.order_id,
        COALESCE(
          CASE
            WHEN oe.meta ? 'amount_cents'
              AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
            THEN (oe.meta->>'amount_cents')::bigint
            ELSE NULL
          END,
          po.paid_cents,
          po.total_cents,
          0
        ) AS amount_cents
      FROM order_events oe
      JOIN paid_orders po ON po.id = oe.order_id
      WHERE oe.event_type = 'ORDER_COMPED'
        AND oe.created_at >= $2
        AND oe.created_at < $3
      ORDER BY oe.order_id, oe.created_at ASC, oe.id ASC
    ),
    voided_orders AS (
      SELECT DISTINCT ON (oe.order_id)
        oe.order_id
      FROM order_events oe
      JOIN orders o ON o.id = oe.order_id
      WHERE o.restaurant_id = $1
        AND oe.event_type = 'ORDER_VOIDED'
        AND oe.created_at >= $2
        AND oe.created_at < $3
      ORDER BY oe.order_id, oe.created_at ASC, oe.id ASC
    )
    SELECT
      COUNT(po.id) AS total_orders,
      COALESCE(SUM(po.paid_cents), 0) AS total_revenue,
      COALESCE((SELECT SUM(amount_cents) FROM comped_orders), 0) AS total_comped_amount,
      COALESCE((SELECT COUNT(*) FROM voided_orders), 0) AS total_voided_orders,
      (
        COALESCE(SUM(po.paid_cents), 0)
        - COALESCE((SELECT SUM(amount_cents) FROM comped_orders), 0)
      ) AS net_revenue
    FROM paid_orders po;
  `,

  /**
   * Phase 29 — Overrides Baseline
   *
   * Backend-authoritative manager override activity for overview reporting.
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   */
  overridesBaseline: `
    WITH override_events AS (
      SELECT
        oe.id AS event_id,
        oe.order_id,
        oe.event_type,
        oe.actor_user_id,
        oe.actor_role,
        oe.actor_firebase_uid,
        oe.created_at,
        COALESCE(oe.meta, '{}'::jsonb) AS metadata,
        COALESCE(
          CASE
            WHEN oe.meta ? 'amount_cents'
              AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
            THEN (oe.meta->>'amount_cents')::bigint
            ELSE NULL
          END,
          o.paid_cents,
          o.total_cents,
          0
        ) AS amount_cents
      FROM order_events oe
      JOIN orders o ON o.id = oe.order_id
      WHERE o.restaurant_id = $1
        AND oe.event_type IN ('ORDER_COMPED', 'ORDER_VOIDED')
        AND oe.created_at >= $2
        AND oe.created_at < $3
    ),
    deduped_events AS (
      SELECT DISTINCT ON (order_id, event_type)
        event_id,
        order_id,
        event_type,
        actor_user_id,
        actor_role,
        actor_firebase_uid,
        created_at,
        metadata,
        amount_cents
      FROM override_events
      ORDER BY order_id, event_type, created_at ASC, event_id ASC
    )
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'ORDER_COMPED') AS total_comps,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_VOIDED') AS total_voids,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_COMPED'), 0) AS comped_amount,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'event_id', event_id,
            'order_id', order_id,
            'actor_user_id', actor_user_id,
            'actor_role', actor_role,
            'actor_firebase_uid', actor_firebase_uid,
            'timestamp', created_at,
            'amount_cents', amount_cents,
            'metadata', metadata
          )
          ORDER BY created_at DESC, event_id DESC
        ) FILTER (WHERE event_type = 'ORDER_COMPED'),
        '[]'::jsonb
      ) AS comp_events,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'event_id', event_id,
            'order_id', order_id,
            'actor_user_id', actor_user_id,
            'actor_role', actor_role,
            'actor_firebase_uid', actor_firebase_uid,
            'timestamp', created_at,
            'amount_cents', amount_cents,
            'metadata', metadata
          )
          ORDER BY created_at DESC, event_id DESC
        ) FILTER (WHERE event_type = 'ORDER_VOIDED'),
        '[]'::jsonb
      ) AS void_events
    FROM deduped_events;
  `,

  /**
   * Phase 8.1 — Daily Sales Summary
   *
   * Returns one row per day with:
   *  - closed_order_count
   *  - open_order_count
   *  - gross_sales_cents
   *  - avg_ticket_cents
   */
  dailySalesSummary: `
    WITH closed_orders AS (
      SELECT
        (closed_at AT TIME ZONE $3)::date AS day,
        COUNT(*) AS closed_order_count,
        SUM(total_cents) AS gross_sales_cents,
        SUM(tax_cents) AS tax_cents_sum,
        SUM(tip_cents) AS tip_cents_sum
      FROM orders
      WHERE restaurant_id = $1
        AND status = 'CLOSED'
        AND closed_at IS NOT NULL
        AND (closed_at AT TIME ZONE $3)::date BETWEEN $2 AND $4
      GROUP BY day
    ),
    open_orders AS (
      SELECT
        (opened_at AT TIME ZONE $3)::date AS day,
        COUNT(*) AS open_order_count
      FROM orders
      WHERE restaurant_id = $1
        AND status IN ('OPEN','SENT','READY')
        AND opened_at IS NOT NULL
        AND (opened_at AT TIME ZONE $3)::date BETWEEN $2 AND $4
      GROUP BY day
    )
    SELECT
      d.day,
      COALESCE(c.closed_order_count, 0) AS closed_order_count,
      COALESCE(o.open_order_count, 0) AS open_order_count,
      COALESCE(c.gross_sales_cents, 0) AS gross_sales_cents,
      CASE
        WHEN COALESCE(c.closed_order_count, 0) = 0 THEN 0
        ELSE ROUND(c.gross_sales_cents::numeric / c.closed_order_count)
      END AS avg_ticket_cents,
      COALESCE(c.tax_cents_sum, 0) AS tax_cents_sum,
      COALESCE(c.tip_cents_sum, 0) AS tip_cents_sum
    FROM (
      SELECT generate_series($2::date, $4::date, interval '1 day')::date AS day
    ) d
    LEFT JOIN closed_orders c ON c.day = d.day
    LEFT JOIN open_orders o ON o.day = d.day
    ORDER BY d.day ASC;
  `,

  /**
   * Phase 8.1 — Status Breakdown
   */
  statusBreakdown: `
    SELECT
      status,
      COUNT(*) AS order_count
    FROM orders
    WHERE restaurant_id = $1
      AND opened_at >= $2
      AND opened_at < $3
    GROUP BY status
    ORDER BY status;
  `,

  /**
   * Phase 8.1 — Shift Sales Summary
   * Sales are attributed to shifts based on orders closed during the shift window.
   */
  shiftSalesSummary: `
    WITH shift_rows AS (
      SELECT
        s.id AS shift_id,
        s.user_id,
        s.clock_in_at,
        s.clock_out_at,
        ROUND(
          EXTRACT(EPOCH FROM (COALESCE(s.clock_out_at, $3) - s.clock_in_at)) / 60.0
        ) AS duration_minutes
      FROM shifts s
      WHERE s.restaurant_id = $1
        AND s.clock_in_at >= $2
        AND s.clock_in_at < $3
    ),
    assigned_orders AS (
      SELECT
        o.id AS order_id,
        o.total_cents,
        matched_shift.shift_id
      FROM orders o
      JOIN LATERAL (
        SELECT sr.shift_id
        FROM shift_rows sr
        WHERE o.closed_at >= sr.clock_in_at
          AND o.closed_at < COALESCE(sr.clock_out_at, $3)
        ORDER BY sr.clock_in_at DESC, sr.shift_id ASC
        LIMIT 1
      ) matched_shift ON TRUE
      WHERE o.restaurant_id = $1
        AND o.status = 'CLOSED'
        AND o.closed_at IS NOT NULL
        AND o.closed_at >= $2
        AND o.closed_at < $3
    )
    SELECT
      sr.shift_id,
      sr.user_id,
      sr.clock_in_at,
      sr.clock_out_at,
      sr.duration_minutes,
      COUNT(ao.order_id) AS closed_order_count,
      COALESCE(SUM(ao.total_cents), 0) AS gross_sales_cents,
      CASE
        WHEN COUNT(ao.order_id) = 0 THEN 0
        ELSE ROUND(SUM(ao.total_cents)::numeric / COUNT(ao.order_id))
      END AS avg_ticket_cents
    FROM shift_rows sr
    LEFT JOIN assigned_orders ao ON ao.shift_id = sr.shift_id
    GROUP BY
      sr.shift_id,
      sr.user_id,
      sr.clock_in_at,
      sr.clock_out_at,
      sr.duration_minutes
    ORDER BY sr.clock_in_at ASC, sr.shift_id ASC;
  `,

  /**
   * Phase 8.2 — Void & Comp Summary (range)
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   */
  voidsCompsSummary: `
    WITH raw_events AS (
      SELECT
        oe.id AS event_id,
        oe.order_id,
        oe.event_type,
        oe.actor_user_id,
        oe.actor_role,
        oe.created_at,
        COALESCE(NULLIF(oe.meta->>'reason', ''), 'UNSPECIFIED') AS reason,
        CASE
          WHEN oe.meta ? 'amount_cents'
            AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
          THEN FALSE
          ELSE TRUE
        END AS amount_inferred,
        COALESCE(
          CASE
            WHEN oe.meta ? 'amount_cents'
              AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
            THEN (oe.meta->>'amount_cents')::bigint
            ELSE NULL
          END,
          o.paid_cents,
          o.total_cents,
          0
        ) AS amount_cents
      FROM order_events oe
      JOIN orders o ON o.id = oe.order_id
      WHERE o.restaurant_id = $1
        AND oe.event_type IN ('ORDER_VOIDED', 'ORDER_COMPED')
        AND oe.created_at >= $2
        AND oe.created_at < $3
    ),
    base AS (
      SELECT DISTINCT ON (order_id, event_type)
        event_id,
        order_id,
        event_type,
        actor_user_id,
        actor_role,
        created_at,
        reason,
        amount_inferred,
        amount_cents
      FROM raw_events
      ORDER BY order_id, event_type, created_at ASC, event_id ASC
    )
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'ORDER_VOIDED') AS void_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_VOIDED'), 0) AS void_amount_cents,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_COMPED') AS comp_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_COMPED'), 0) AS comp_amount_cents,
      COALESCE(SUM(amount_cents), 0) AS total_impact_cents,
      COUNT(*) FILTER (WHERE amount_inferred = TRUE) AS inferred_amount_count,
      COUNT(*) FILTER (WHERE actor_user_id IS NULL) AS unknown_actor_count
    FROM base;
  `,
  /**
   * Phase 8.2 — Void & Comp By Employee (range)
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   */
  voidsCompsByEmployee: `
    WITH raw_events AS (
      SELECT
        oe.id AS event_id,
        oe.order_id,
        oe.event_type,
        oe.actor_user_id,
        oe.actor_role,
        oe.actor_firebase_uid,
        oe.created_at,
        CASE
          WHEN oe.meta ? 'amount_cents'
            AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
          THEN FALSE
          ELSE TRUE
        END AS amount_inferred,
        COALESCE(
          CASE
            WHEN oe.meta ? 'amount_cents'
              AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
            THEN (oe.meta->>'amount_cents')::bigint
            ELSE NULL
          END,
          o.paid_cents,
          o.total_cents,
          0
        ) AS amount_cents
      FROM order_events oe
      JOIN orders o ON o.id = oe.order_id
      WHERE o.restaurant_id = $1
        AND oe.event_type IN ('ORDER_VOIDED', 'ORDER_COMPED')
        AND oe.created_at >= $2
        AND oe.created_at < $3
    ),
    base AS (
      SELECT DISTINCT ON (order_id, event_type)
        event_id,
        order_id,
        event_type,
        actor_user_id,
        actor_role,
        actor_firebase_uid,
        created_at,
        amount_inferred,
        amount_cents
      FROM raw_events
      ORDER BY order_id, event_type, created_at ASC, event_id ASC
    )
    SELECT
      actor_user_id,
      actor_role,
      actor_firebase_uid,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_VOIDED') AS void_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_VOIDED'), 0) AS void_amount_cents,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_COMPED') AS comp_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_COMPED'), 0) AS comp_amount_cents,
      COALESCE(SUM(amount_cents), 0) AS total_impact_cents,
      COUNT(*) FILTER (WHERE amount_inferred = TRUE) AS inferred_amount_count
    FROM base
    GROUP BY actor_user_id, actor_role, actor_firebase_uid
    ORDER BY
      total_impact_cents DESC,
      actor_user_id ASC NULLS LAST,
      actor_role ASC,
      actor_firebase_uid ASC NULLS LAST;
  `,
  /**
   * Phase 8.2 — Void & Comp By Reason (range)
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   */
  voidsCompsByReason: `
    WITH raw_events AS (
      SELECT
        oe.id AS event_id,
        oe.order_id,
        oe.event_type,
        oe.created_at,
        COALESCE(NULLIF(oe.meta->>'reason', ''), 'UNSPECIFIED') AS reason,
        CASE
          WHEN oe.meta ? 'amount_cents'
            AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
          THEN FALSE
          ELSE TRUE
        END AS amount_inferred,
        COALESCE(
          CASE
            WHEN oe.meta ? 'amount_cents'
              AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
            THEN (oe.meta->>'amount_cents')::bigint
            ELSE NULL
          END,
          o.paid_cents,
          o.total_cents,
          0
        ) AS amount_cents
      FROM order_events oe
      JOIN orders o ON o.id = oe.order_id
      WHERE o.restaurant_id = $1
        AND oe.event_type IN ('ORDER_VOIDED', 'ORDER_COMPED')
        AND oe.created_at >= $2
        AND oe.created_at < $3
    ),
    base AS (
      SELECT DISTINCT ON (order_id, event_type)
        event_id,
        order_id,
        event_type,
        created_at,
        reason,
        amount_inferred,
        amount_cents
      FROM raw_events
      ORDER BY order_id, event_type, created_at ASC, event_id ASC
    )
    SELECT
      reason,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_VOIDED') AS void_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_VOIDED'), 0) AS void_amount_cents,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_COMPED') AS comp_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_COMPED'), 0) AS comp_amount_cents,
      COALESCE(SUM(amount_cents), 0) AS total_impact_cents,
      COUNT(*) FILTER (WHERE amount_inferred = TRUE) AS inferred_amount_count
    FROM base
    GROUP BY reason
    ORDER BY total_impact_cents DESC, reason ASC;
  `,
  /**
   * Phase 8.2 — Void & Comp Timeseries (hour/day buckets)
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   *  $4 bucket ('hour' | 'day')
   *  $5 tz (IANA, e.g. 'America/New_York')
   */
  voidsCompsTimeseries: `
    WITH raw_events AS (
      SELECT
        oe.id AS event_id,
        oe.order_id,
        oe.event_type,
        oe.created_at,
        date_trunc($4, (oe.created_at AT TIME ZONE $5)) AS bucket_start,
        CASE
          WHEN oe.meta ? 'amount_cents'
            AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
          THEN FALSE
          ELSE TRUE
        END AS amount_inferred,
        COALESCE(
          CASE
            WHEN oe.meta ? 'amount_cents'
              AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
            THEN (oe.meta->>'amount_cents')::bigint
            ELSE NULL
          END,
          o.paid_cents,
          o.total_cents,
          0
        ) AS amount_cents
      FROM order_events oe
      JOIN orders o ON o.id = oe.order_id
      WHERE o.restaurant_id = $1
        AND oe.event_type IN ('ORDER_VOIDED', 'ORDER_COMPED')
        AND oe.created_at >= $2
        AND oe.created_at < $3
    ),
    base AS (
      SELECT DISTINCT ON (order_id, event_type)
        event_id,
        order_id,
        event_type,
        created_at,
        bucket_start,
        amount_inferred,
        amount_cents
      FROM raw_events
      ORDER BY order_id, event_type, created_at ASC, event_id ASC
    )
    SELECT
      bucket_start,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_VOIDED') AS void_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_VOIDED'), 0) AS void_amount_cents,
      COUNT(*) FILTER (WHERE event_type = 'ORDER_COMPED') AS comp_count,
      COALESCE(SUM(amount_cents) FILTER (WHERE event_type = 'ORDER_COMPED'), 0) AS comp_amount_cents,
      COALESCE(SUM(amount_cents), 0) AS total_impact_cents,
      COUNT(*) FILTER (WHERE amount_inferred = TRUE) AS inferred_amount_count
    FROM base
    GROUP BY bucket_start
    ORDER BY bucket_start ASC;
  `,
  /**
   * Phase 8.2 — Void & Comp Line Items (paged)
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   *  $4 limit (int)
   *  $5 offset (int)
   */
  voidsCompsLineItems: `
    WITH raw_events AS (
      SELECT
        oe.id AS event_id,
        oe.order_id,
        oe.event_type,
        oe.created_at,
        oe.actor_user_id,
        oe.actor_role,
        oe.actor_firebase_uid,
        COALESCE(NULLIF(oe.meta->>'reason', ''), 'UNSPECIFIED') AS reason,
        CASE
          WHEN oe.meta ? 'amount_cents'
            AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
          THEN FALSE
          ELSE TRUE
        END AS amount_inferred,
        COALESCE(
          CASE
            WHEN oe.meta ? 'amount_cents'
              AND (oe.meta->>'amount_cents') ~ '^[0-9]+$'
            THEN (oe.meta->>'amount_cents')::bigint
            ELSE NULL
          END,
          o.paid_cents,
          o.total_cents,
          0
        ) AS amount_cents
      FROM order_events oe
      JOIN orders o ON o.id = oe.order_id
      WHERE o.restaurant_id = $1
        AND oe.event_type IN ('ORDER_VOIDED', 'ORDER_COMPED')
        AND oe.created_at >= $2
        AND oe.created_at < $3
    ),
    deduped_events AS (
      SELECT DISTINCT ON (order_id, event_type)
        event_id,
        order_id,
        event_type,
        created_at,
        actor_user_id,
        actor_role,
        actor_firebase_uid,
        reason,
        amount_inferred,
        amount_cents
      FROM raw_events
      ORDER BY order_id, event_type, created_at ASC, event_id ASC
    )
    SELECT
      event_id,
      order_id,
      event_type,
      created_at,
      actor_user_id,
      actor_role,
      actor_firebase_uid,
      reason,
      amount_inferred,
      amount_cents
    FROM deduped_events
    ORDER BY created_at DESC, event_id DESC
    LIMIT $4 OFFSET $5;
  `,
  /**
   * Phase 8.3 — Labor vs Sales Daily (date range)
   *
   * Notes:
   * - Labor is bucketed by shift clock-in date in the provided timezone.
   * - Sales are bucketed by order closed_at date in the provided timezone.
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start_date (date, inclusive)
   *  $3 tz (IANA, e.g. 'America/New_York')
   *  $4 end_date (date, inclusive)
   *  $5 report_end (timestamptz, exclusive)
   */
  laborVsSalesDaily: `
    WITH labor AS (
      SELECT
        (s.clock_in_at AT TIME ZONE $3)::date AS day,
        COUNT(*) AS shifts_count,
        COUNT(*) FILTER (WHERE s.clock_out_at IS NULL) AS incomplete_shifts_count,
        COALESCE(SUM(
          ROUND(
            EXTRACT(EPOCH FROM (COALESCE(s.clock_out_at, $5) - s.clock_in_at)) / 60.0
          )
        ), 0) AS labor_minutes_total
      FROM shifts s
      WHERE s.restaurant_id = $1
        AND (s.clock_in_at AT TIME ZONE $3)::date BETWEEN $2 AND $4
      GROUP BY day
    ),
    sales AS (
      SELECT
        (o.closed_at AT TIME ZONE $3)::date AS day,
        COUNT(*) AS closed_order_count,
        COALESCE(SUM(o.total_cents), 0) AS gross_sales_cents
      FROM orders o
      WHERE o.restaurant_id = $1
        AND o.status = 'CLOSED'
        AND o.closed_at IS NOT NULL
        AND (o.closed_at AT TIME ZONE $3)::date BETWEEN $2 AND $4
      GROUP BY day
    )
    SELECT
      d.day,
      COALESCE(l.shifts_count, 0) AS shifts_count,
      COALESCE(l.incomplete_shifts_count, 0) AS incomplete_shifts_count,
      COALESCE(l.labor_minutes_total, 0) AS labor_minutes_total,
      ROUND(COALESCE(l.labor_minutes_total, 0)::numeric / 60.0, 2) AS labor_hours_total,
      COALESCE(s.closed_order_count, 0) AS closed_order_count,
      COALESCE(s.gross_sales_cents, 0) AS gross_sales_cents,
      CASE
        WHEN COALESCE(l.labor_minutes_total, 0) = 0 THEN 0
        ELSE ROUND(COALESCE(s.gross_sales_cents, 0)::numeric / (COALESCE(l.labor_minutes_total, 0)::numeric / 60.0))
      END AS sales_per_labor_hour_cents
    FROM (
      SELECT generate_series($2::date, $4::date, interval '1 day')::date AS day
    ) d
    LEFT JOIN labor l ON l.day = d.day
    LEFT JOIN sales s ON s.day = d.day
    ORDER BY d.day ASC;
  `,

  /**
   * Phase 8.3 — Labor vs Sales By Shift (time window)
   * Sales are attributed to a shift based on orders closed during the shift window.
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   */
  laborVsSalesByShift: `
    WITH shift_rows AS (
      SELECT
        s.id AS shift_id,
        s.user_id,
        s.clock_in_at,
        s.clock_out_at,
        ROUND(
          EXTRACT(EPOCH FROM (COALESCE(s.clock_out_at, $3) - s.clock_in_at)) / 60.0
        ) AS labor_minutes
      FROM shifts s
      WHERE s.restaurant_id = $1
        AND s.clock_in_at >= $2
        AND s.clock_in_at < $3
    ),
    assigned_orders AS (
      SELECT
        o.id AS order_id,
        o.total_cents,
        matched_shift.shift_id
      FROM orders o
      JOIN LATERAL (
        SELECT sr.shift_id
        FROM shift_rows sr
        WHERE o.closed_at >= sr.clock_in_at
          AND o.closed_at < COALESCE(sr.clock_out_at, $3)
        ORDER BY sr.clock_in_at DESC, sr.shift_id ASC
        LIMIT 1
      ) matched_shift ON TRUE
      WHERE o.restaurant_id = $1
        AND o.status = 'CLOSED'
        AND o.closed_at IS NOT NULL
        AND o.closed_at >= $2
        AND o.closed_at < $3
    )
    SELECT
      sr.shift_id,
      sr.user_id,
      sr.clock_in_at,
      sr.clock_out_at,
      sr.labor_minutes AS duration_minutes,
      COUNT(ao.order_id) AS closed_order_count,
      COALESCE(SUM(ao.total_cents), 0) AS gross_sales_cents,
      CASE
        WHEN sr.labor_minutes = 0 THEN 0
        ELSE ROUND(
          COALESCE(SUM(ao.total_cents), 0)::numeric
          / (sr.labor_minutes::numeric / 60.0)
        )
      END AS sales_per_labor_hour_cents
    FROM shift_rows sr
    LEFT JOIN assigned_orders ao ON ao.shift_id = sr.shift_id
    GROUP BY
      sr.shift_id,
      sr.user_id,
      sr.clock_in_at,
      sr.clock_out_at,
      sr.labor_minutes
    ORDER BY sr.clock_in_at ASC, sr.shift_id ASC;
  `,

  /**
   * Phase 8.3 — Labor vs Sales By Employee (time window)
   * Aggregates per-employee from shifts in the window. Sales are attributed to that employee's shift windows.
   *
   * Params:
   *  $1 restaurant_id (uuid)
   *  $2 start (timestamptz, inclusive)
   *  $3 end   (timestamptz, exclusive)
   */
  laborVsSalesByEmployee: `
    WITH shift_rows AS (
      SELECT
        s.id AS shift_id,
        s.user_id,
        s.clock_in_at,
        s.clock_out_at,
        ROUND(
          EXTRACT(EPOCH FROM (COALESCE(s.clock_out_at, $3) - s.clock_in_at)) / 60.0
        ) AS labor_minutes,
        (s.clock_out_at IS NULL) AS incomplete_shift
      FROM shifts s
      WHERE s.restaurant_id = $1
        AND s.clock_in_at >= $2
        AND s.clock_in_at < $3
    ),
    assigned_orders AS (
      SELECT
        o.id AS order_id,
        o.total_cents,
        matched_shift.shift_id
      FROM orders o
      JOIN LATERAL (
        SELECT sr.shift_id
        FROM shift_rows sr
        WHERE o.closed_at >= sr.clock_in_at
          AND o.closed_at < COALESCE(sr.clock_out_at, $3)
        ORDER BY sr.clock_in_at DESC, sr.shift_id ASC
        LIMIT 1
      ) matched_shift ON TRUE
      WHERE o.restaurant_id = $1
        AND o.status = 'CLOSED'
        AND o.closed_at IS NOT NULL
        AND o.closed_at >= $2
        AND o.closed_at < $3
    ),
    shift_sales AS (
      SELECT
        sr.user_id,
        sr.shift_id,
        sr.labor_minutes,
        sr.incomplete_shift,
        COUNT(ao.order_id) AS closed_order_count,
        COALESCE(SUM(ao.total_cents), 0) AS gross_sales_cents
      FROM shift_rows sr
      LEFT JOIN assigned_orders ao ON ao.shift_id = sr.shift_id
      GROUP BY
        sr.user_id,
        sr.shift_id,
        sr.labor_minutes,
        sr.incomplete_shift
    )
    SELECT
      user_id,
      COUNT(*) AS shifts_count,
      COUNT(*) FILTER (WHERE incomplete_shift = TRUE) AS incomplete_shifts_count,
      COALESCE(SUM(labor_minutes), 0) AS labor_minutes_total,
      ROUND(COALESCE(SUM(labor_minutes), 0)::numeric / 60.0, 2) AS labor_hours_total,
      COALESCE(SUM(closed_order_count), 0) AS closed_order_count,
      COALESCE(SUM(gross_sales_cents), 0) AS gross_sales_cents,
      CASE
        WHEN COALESCE(SUM(labor_minutes), 0) = 0 THEN 0
        ELSE ROUND(
          COALESCE(SUM(gross_sales_cents), 0)::numeric
          / (COALESCE(SUM(labor_minutes), 0)::numeric / 60.0)
        )
      END AS sales_per_labor_hour_cents
    FROM shift_sales
    GROUP BY user_id
    ORDER BY
      gross_sales_cents DESC,
      labor_minutes_total DESC,
      user_id ASC;
  `,
};