
BEGIN;

SET LOCAL search_path = public, pg_catalog;

-- ============================================================================
-- Phase 40F
-- 013_lifecycle_event_normalization.sql
--
-- Forward-only lifecycle normalization migration.
-- Requires 012_order_event_remaining_legacy_repair.sql to have completed successfully.
-- ============================================================================

-- ============================================================================
-- SECTION A — Schema-qualified preflight checks
-- ============================================================================

DO $$
DECLARE
  missing_tables text[] := ARRAY[]::text[];
  missing_columns text[] := ARRAY[]::text[];
  missing_keys text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    missing_tables := array_append(
      missing_tables,
      'public.orders'
    );
  END IF;

  IF to_regclass('public.order_events') IS NULL THEN
    missing_tables := array_append(
      missing_tables,
      'public.order_events'
    );
  END IF;

  IF to_regclass('public.payments') IS NULL THEN
    missing_tables := array_append(
      missing_tables,
      'public.payments'
    );
  END IF;

  IF to_regclass('public.restaurants') IS NULL THEN
    missing_tables := array_append(
      missing_tables,
      'public.restaurants'
    );
  END IF;

  IF to_regclass('public.users') IS NULL THEN
    missing_tables := array_append(
      missing_tables,
      'public.users'
    );
  END IF;

  IF cardinality(missing_tables) > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration requires missing table(s): %',
      array_to_string(missing_tables, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'restaurant_id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.restaurant_id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'status'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.status'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'total_cents'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.total_cents'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'paid_cents'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.paid_cents'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'opened_at'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.opened_at'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'sent_at'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.sent_at'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'ready_at'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.ready_at'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'closed_at'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.orders.closed_at'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'restaurant_id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.restaurant_id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'order_id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.order_id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'event_type'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.event_type'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'actor_user_id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.actor_user_id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'from_status'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.from_status'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'to_status'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.to_status'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'created_at'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.order_events.created_at'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurants'
      AND column_name = 'id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.restaurants.id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'public.users.id'
    );
  END IF;

  IF cardinality(missing_columns) > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration requires missing foundational column(s): %',
      array_to_string(missing_columns, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class c
      ON c.oid = con.conrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND con.contype IN ('p', 'u')
      AND con.conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.orders'::regclass
            AND attname = 'id'
            AND NOT attisdropped
        )
      ]::smallint[]
  ) THEN
    missing_keys := array_append(
      missing_keys,
      'public.orders(id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class c
      ON c.oid = con.conrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'restaurants'
      AND con.contype IN ('p', 'u')
      AND con.conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.restaurants'::regclass
            AND attname = 'id'
            AND NOT attisdropped
        )
      ]::smallint[]
  ) THEN
    missing_keys := array_append(
      missing_keys,
      'public.restaurants(id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class c
      ON c.oid = con.conrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'users'
      AND con.contype IN ('p', 'u')
      AND con.conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.users'::regclass
            AND attname = 'id'
            AND NOT attisdropped
        )
      ]::smallint[]
  ) THEN
    missing_keys := array_append(
      missing_keys,
      'public.users(id)'
    );
  END IF;

  IF cardinality(missing_keys) > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration requires missing referenced key(s): %',
      array_to_string(missing_keys, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n
      ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'order_event_type'
      AND t.typtype = 'e'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F migration requires enum public.order_event_type';
  END IF;
END;
$$;

-- ============================================================================
-- SECTION B — Required lifecycle and financial columns
-- ============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS table_id text,
  ADD COLUMN IF NOT EXISTS recalled_at timestamptz,
  ADD COLUMN IF NOT EXISTS comped_cents integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n
      ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'order_origin'
      AND t.typtype = 'e'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F migration requires enum public.order_origin';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'order_origin'
  ) THEN
    ALTER TABLE public.orders
      ADD COLUMN order_origin public.order_origin;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'order_origin'
      AND (
        udt_schema <> 'public'
        OR udt_name <> 'order_origin'
      )
  ) THEN

    IF EXISTS (
      SELECT 1
      FROM public.orders
      WHERE order_origin IS NOT NULL
        AND order_origin::text NOT IN ('CUSTOMER','STAFF')
    ) THEN
      RAISE EXCEPTION
        'Phase 40F migration found invalid order_origin values';
    END IF;

    ALTER TABLE public.orders
      ALTER COLUMN order_origin DROP DEFAULT;

    ALTER TABLE public.orders
      ALTER COLUMN order_origin
      TYPE public.order_origin
      USING order_origin::text::public.order_origin;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.orders
    WHERE order_origin IS NULL
  ) THEN
    RAISE EXCEPTION
      'Phase 40F migration found orders without authoritative order_origin';
  END IF;

  ALTER TABLE public.orders
    ALTER COLUMN order_origin SET NOT NULL;
END;
$$;

-- ============================================================================
-- SECTION C — Financial data validation and constraints
-- ============================================================================

DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO invalid_count
  FROM public.orders
  WHERE COALESCE(total_cents, 0) < 0
     OR COALESCE(paid_cents, 0) < 0
     OR COALESCE(comped_cents, 0) < 0
     OR COALESCE(paid_cents, 0) > COALESCE(total_cents, 0)
     OR COALESCE(comped_cents, 0) > COALESCE(total_cents, 0)
     OR (
          COALESCE(paid_cents, 0)
        + COALESCE(comped_cents, 0)
        ) > COALESCE(total_cents, 0);

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F financial validation failed: % order row(s) violate settlement invariants',
      invalid_count;
  END IF;
END;
$$;

DO $$
DECLARE
  unsettled_count bigint;
  invalid_timestamp_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO unsettled_count
  FROM public.orders
  WHERE status IN ('SENT', 'READY', 'CLOSED')
    AND (
      COALESCE(paid_cents, 0)
      + COALESCE(comped_cents, 0)
    ) < COALESCE(total_cents, 0);

  IF unsettled_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % unsettled order(s) beyond OPEN',
      unsettled_count;
  END IF;

  SELECT COUNT(*)
  INTO invalid_timestamp_count
  FROM public.orders
  WHERE
       (
         status = 'OPEN'
         AND (
           sent_at IS NOT NULL
           OR ready_at IS NOT NULL
           OR recalled_at IS NOT NULL
           OR closed_at IS NOT NULL
         )
       )
    OR (
         status = 'SENT'
         AND (
           sent_at IS NULL
           OR ready_at IS NOT NULL
           OR closed_at IS NOT NULL
         )
       )
    OR (
         status = 'READY'
         AND (
           sent_at IS NULL
           OR ready_at IS NULL
           OR closed_at IS NOT NULL
         )
       )
    OR (
         status = 'CLOSED'
         AND (
           sent_at IS NULL
           OR ready_at IS NULL
           OR closed_at IS NULL
         )
       )
    OR (
         status = 'CANCELLED'
         AND (
           closed_at IS NOT NULL
           OR (
             ready_at IS NOT NULL
             AND sent_at IS NULL
           )
         )
       );

  IF invalid_timestamp_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % order(s) with contradictory lifecycle timestamps',
      invalid_timestamp_count;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.orders
    WHERE total_cents IS NULL
       OR paid_cents IS NULL
       OR comped_cents IS NULL
  ) THEN
    RAISE EXCEPTION
      'Phase 40F migration found NULL financial values';
  END IF;

  ALTER TABLE public.orders
    ALTER COLUMN total_cents SET NOT NULL,
    ALTER COLUMN paid_cents SET NOT NULL,
    ALTER COLUMN comped_cents SET NOT NULL;
END;
$$;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS chk_orders_total_cents_nonnegative,
  DROP CONSTRAINT IF EXISTS chk_orders_paid_cents_nonnegative,
  DROP CONSTRAINT IF EXISTS chk_orders_comped_cents_nonnegative,
  DROP CONSTRAINT IF EXISTS chk_orders_paid_not_over_total,
  DROP CONSTRAINT IF EXISTS chk_orders_comped_not_over_total,
  DROP CONSTRAINT IF EXISTS chk_orders_settlement_not_over_total;

ALTER TABLE public.orders
  ADD CONSTRAINT chk_orders_total_cents_nonnegative
    CHECK (COALESCE(total_cents, 0) >= 0),

  ADD CONSTRAINT chk_orders_paid_cents_nonnegative
    CHECK (COALESCE(paid_cents, 0) >= 0),

  ADD CONSTRAINT chk_orders_comped_cents_nonnegative
    CHECK (COALESCE(comped_cents, 0) >= 0),

  ADD CONSTRAINT chk_orders_paid_not_over_total
    CHECK (
      COALESCE(paid_cents, 0)
      <= COALESCE(total_cents, 0)
    ),

  ADD CONSTRAINT chk_orders_comped_not_over_total
    CHECK (
      COALESCE(comped_cents, 0)
      <= COALESCE(total_cents, 0)
    ),

  ADD CONSTRAINT chk_orders_settlement_not_over_total
    CHECK (
      COALESCE(paid_cents, 0)
      + COALESCE(comped_cents, 0)
      <= COALESCE(total_cents, 0)
    );


-- ============================================================================
-- SECTION D — Canonical order event contract normalization
-- ============================================================================

DO $$
DECLARE
  unsupported_dependencies text;
BEGIN
  SELECT string_agg(
    DISTINCT pg_describe_object(
      d.classid,
      d.objid,
      d.objsubid
    ),
    E'\n'
  )
  INTO unsupported_dependencies
  FROM pg_depend d
  JOIN pg_type t
    ON t.oid = d.refobjid
  JOIN pg_namespace n
    ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
    AND t.typname = 'order_event_type'
    AND d.deptype NOT IN ('i', 'e')
    AND NOT (
      d.classid = 'pg_class'::regclass
      AND d.objid = 'public.order_events'::regclass
      AND d.objsubid = (
        SELECT attnum
        FROM pg_attribute
        WHERE attrelid = 'public.order_events'::regclass
          AND attname = 'event_type'
          AND NOT attisdropped
      )
    );

  IF unsupported_dependencies IS NOT NULL THEN
    RAISE EXCEPTION
      'Phase 40F migration found unsupported public.order_event_type dependencies:%',
      E'\n' || unsupported_dependencies;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n
      ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'order_actor_type'
      AND t.typtype = 'e'
  ) THEN
    CREATE TYPE public.order_actor_type AS ENUM (
      'USER',
      'CUSTOMER',
      'SYSTEM',
      'PAYMENT_PROVIDER'
    );
  END IF;
END;
$$;

ALTER TABLE public.order_events
  ADD COLUMN IF NOT EXISTS actor_firebase_uid text,
  ADD COLUMN IF NOT EXISTS actor_type public.order_actor_type,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS meta jsonb;

DO $$
DECLARE
  metadata_type text;
BEGIN
  SELECT data_type
  INTO metadata_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'order_events'
    AND column_name = 'metadata';

  IF metadata_type IS NOT NULL THEN
    IF metadata_type = 'jsonb' THEN
      EXECUTE '
        UPDATE public.order_events
        SET meta = COALESCE(
          meta,
          metadata,
          ''{}''::jsonb
        )
      ';
    ELSIF metadata_type = 'json' THEN
      EXECUTE '
        UPDATE public.order_events
        SET meta = COALESCE(
          meta,
          metadata::jsonb,
          ''{}''::jsonb
        )
      ';
    ELSIF metadata_type IN (
      'text',
      'character varying'
    ) THEN
      BEGIN
        EXECUTE '
          UPDATE public.order_events
          SET meta = COALESCE(
            meta,
            NULLIF(btrim(metadata), '''')::jsonb,
            ''{}''::jsonb
          )
        ';
      EXCEPTION
        WHEN invalid_text_representation THEN
          RAISE EXCEPTION
            'Phase 40F migration found non-JSON legacy order_events.metadata text';
      END;
    ELSE
      RAISE EXCEPTION
        'Phase 40F migration cannot convert order_events.metadata type %',
        metadata_type;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.order_events
      WHERE meta IS NULL
         OR jsonb_typeof(meta) <> 'object'
    ) THEN
      RAISE EXCEPTION
        'Phase 40F migration found invalid normalized order_events.meta payloads';
    END IF;

    ALTER TABLE public.order_events
      DROP COLUMN metadata;
  ELSE
    UPDATE public.order_events
    SET meta = '{}'::jsonb
    WHERE meta IS NULL;
  END IF;
END;
$$;

ALTER TABLE public.order_events
  ALTER COLUMN event_type DROP DEFAULT;

ALTER TABLE public.order_events
  ALTER COLUMN event_type TYPE text
  USING event_type::text;

UPDATE public.order_events
SET event_type = 'STATUS_CHANGED'
WHERE event_type = 'STATUS_CHANGE';

UPDATE public.order_events
SET event_type = 'ORDER_OVERRIDE'
WHERE event_type = 'STATUS_OVERRIDDEN';

DO $$
DECLARE
  invalid_event_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO invalid_event_count
  FROM public.order_events
  WHERE event_type IS NULL
     OR event_type NOT IN (
       'ORDER_CREATED',
       'PAYMENT_RECORDED',
       'STATUS_CHANGED',
       'RECALL',
       'ORDER_VOIDED',
       'ORDER_COMPED',
       'ORDER_OVERRIDE'
     );

  IF invalid_event_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % unsupported order_event event_type value(s)',
      invalid_event_count;
  END IF;
END;
$$;

DROP TYPE IF EXISTS public.order_event_type_phase40f;

CREATE TYPE public.order_event_type_phase40f AS ENUM (
  'ORDER_CREATED',
  'PAYMENT_RECORDED',
  'STATUS_CHANGED',
  'RECALL',
  'ORDER_VOIDED',
  'ORDER_COMPED',
  'ORDER_OVERRIDE'
);

ALTER TABLE public.order_events
  ALTER COLUMN event_type
  TYPE public.order_event_type_phase40f
  USING event_type::public.order_event_type_phase40f;

DROP TYPE public.order_event_type;

ALTER TYPE public.order_event_type_phase40f
  RENAME TO order_event_type;

UPDATE public.order_events
SET actor_type = CASE
  WHEN actor_user_id IS NOT NULL
    THEN 'USER'::public.order_actor_type
  WHEN event_type = 'PAYMENT_RECORDED'
    THEN 'PAYMENT_PROVIDER'::public.order_actor_type
  ELSE 'SYSTEM'::public.order_actor_type
END
WHERE actor_type IS NULL;


-- Legacy event repair removed.
-- Migrations 011_order_event_legacy_repair.sql and 012_order_event_remaining_legacy_repair.sql are the sole authoritative
-- repair migration for the 18 historical lifecycle events.
--
-- Preconditions:
-- * Migrations 011 and 012 must already have completed successfully.
-- * The 18 historical lifecycle events must already match the
--   authoritative Phase 40F repair contract.
-- * The validation blocks below intentionally fail closed if any
--   repaired event has drifted from the canonical state established
--   by migration 011.

DO $$
DECLARE
  invalid_count integer;
BEGIN
  WITH expected_events (
    event_id,
    expected_event_type,
    expected_order_id,
    expected_amount_cents,
    expected_legacy_classification
  ) AS (
    VALUES
      (
        '1b44188b-2f49-48ba-a630-2219c15dcd31'::uuid,
        'ORDER_COMPED'::text,
        'b09386e4-86fc-4e05-a0e3-d6e364dbecde'::uuid,
        700::bigint,
        NULL::text
      ),
      (
        'ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid,
        'ORDER_COMPED'::text,
        '22429f3b-bb64-4e6b-a0c8-049d3a9da154'::uuid,
        0::bigint,
        'NO_OP_COMP_ATTEMPT'::text
      ),
      (
        '8d7618b3-c010-46ff-99e4-b3cb07f66543'::uuid,
        'ORDER_COMPED'::text,
        '63563e8a-db1d-47f0-ba0e-09b38cd526f0'::uuid,
        2900::bigint,
        NULL::text
      ),
      (
        'b5c4d2af-8a36-47f6-b391-7a3f05abf9b0'::uuid,
        'ORDER_COMPED'::text,
        '08043765-16f2-4e53-8036-69400211ce93'::uuid,
        2900::bigint,
        NULL::text
      ),
      (
        '5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid,
        'ORDER_COMPED'::text,
        'f4a2430c-6004-4eeb-9b6f-bbc2e617cc4d'::uuid,
        0::bigint,
        'NO_OP_COMP_ATTEMPT'::text
      ),
      (
        '7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid,
        'ORDER_COMPED'::text,
        '08043765-16f2-4e53-8036-69400211ce93'::uuid,
        0::bigint,
        'NO_OP_COMP_ATTEMPT'::text
      ),
      (
        '4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid,
        'ORDER_COMPED'::text,
        '08043765-16f2-4e53-8036-69400211ce93'::uuid,
        0::bigint,
        'NO_OP_COMP_ATTEMPT'::text
      ),
      (
        'a361a328-feb5-4e43-abfe-a103c6dd125e'::uuid,
        'ORDER_COMPED'::text,
        '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid,
        1400::bigint,
        NULL::text
      ),
      (
        'b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid,
        'ORDER_COMPED'::text,
        '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid,
        0::bigint,
        'NO_OP_COMP_ATTEMPT'::text
      ),
      (
        'beb12727-d987-462d-bf83-ca19528eed7c'::uuid,
        'ORDER_COMPED'::text,
        '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid,
        0::bigint,
        'NO_OP_COMP_ATTEMPT'::text
      ),
      (
        '91c2c869-cde8-4da6-ac71-a1652b04b5e3'::uuid,
        'ORDER_COMPED'::text,
        '37bf1377-01f1-4cdb-9d7c-58c0b4635e25'::uuid,
        4900::bigint,
        NULL::text
      ),
      (
        'c7911dfa-be31-4f0b-8b38-0ed9504fa117'::uuid,
        'ORDER_COMPED'::text,
        'b8552aa7-dd3d-432b-a558-5b38b2972ed6'::uuid,
        4600::bigint,
        NULL::text
      ),
      (
        '6987c471-e98f-42fe-9d87-8782e28c3d98'::uuid,
        'ORDER_COMPED'::text,
        '1148bcb9-8323-4e30-a4b7-9188b2aad1b6'::uuid,
        3200::bigint,
        NULL::text
      ),
      (
        '27b02f0c-f2d8-4c91-b8b2-0d4b7fbefac0'::uuid,
        'ORDER_COMPED'::text,
        'a8c51dbc-5d13-4f83-8de7-4f903090dc96'::uuid,
        2900::bigint,
        NULL::text
      ),
      (
        'aedace16-f85a-4374-885b-d4e9fa886b4d'::uuid,
        'ORDER_COMPED'::text,
        '0a0b0e44-fe7c-40aa-bbd4-9cda03649e81'::uuid,
        700::bigint,
        NULL::text
      ),
      (
        '0c162c77-6a68-40e5-93ec-5e94e390320c'::uuid,
        'ORDER_COMPED'::text,
        'f3f20827-ffce-4fea-81cb-af63fb1d5883'::uuid,
        3800::bigint,
        NULL::text
      ),
      (
        '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid,
        'PAYMENT_RECORDED'::text,
        '69f68aa4-44d0-48ca-8aaa-c918443dfe0c'::uuid,
        3700::bigint,
        'LEGACY_CUSTOMER_CHECKOUT'::text
      ),
      (
        '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid,
        'PAYMENT_RECORDED'::text,
        'be536bf5-050f-4742-aa6c-958bed6bc1ad'::uuid,
        2400::bigint,
        'LEGACY_CUSTOMER_CHECKOUT'::text
      )
  )
  SELECT COUNT(*)
    INTO invalid_count
    FROM expected_events expected
    LEFT JOIN public.order_events event
      ON event.id = expected.event_id
   WHERE event.id IS NULL
      OR event.event_type::text
         IS DISTINCT FROM expected.expected_event_type
      OR event.order_id
         IS DISTINCT FROM expected.expected_order_id
      OR (
        expected.expected_event_type = 'ORDER_COMPED'
        AND (
          event.meta->>'actor_role'
            IS DISTINCT FROM 'Manager'
          OR NULLIF(
            btrim(event.meta->>'reason'),
            ''
          ) IS NULL
          OR CASE
               WHEN (
                 event.meta->>'comped_cents'
               ) ~ '^[0-9]+$'
               THEN (
                 event.meta->>'comped_cents'
               )::bigint
               ELSE NULL
             END IS DISTINCT FROM
               expected.expected_amount_cents
          OR (
            expected.expected_legacy_classification
              = 'NO_OP_COMP_ATTEMPT'
            AND event.meta->>'legacy_classification'
              IS DISTINCT FROM 'NO_OP_COMP_ATTEMPT'
          )
          OR (
            expected.expected_legacy_classification IS NULL
            AND event.meta->>'legacy_classification'
              IS NOT DISTINCT FROM 'NO_OP_COMP_ATTEMPT'
          )
        )
      )
      OR (
        expected.expected_event_type = 'PAYMENT_RECORDED'
        AND (
          CASE
            WHEN (
              event.meta->>'amount_cents'
            ) ~ '^[0-9]+$'
            THEN (
              event.meta->>'amount_cents'
            )::bigint
            ELSE NULL
          END IS DISTINCT FROM
            expected.expected_amount_cents
          OR event.meta->>'provider'
            IS DISTINCT FROM 'LEGACY_CUSTOMER_CHECKOUT'
          OR event.meta->>'legacy_classification'
            IS DISTINCT FROM
              expected.expected_legacy_classification
          OR event.meta->>'payment_reference'
            IS DISTINCT FROM (
              'legacy-order:' || event.order_id::text
            )
        )
      );

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration requires migrations 011 and 012 authoritative legacy repair; % event(s) are missing or have drifted',
      invalid_count;
  END IF;
END;
$$;

DO $$
DECLARE
  orphan_order_count bigint;
  orphan_restaurant_count bigint;
  orphan_actor_count bigint;
  tenant_mismatch_count bigint;
  invalid_meta_count bigint;
  invalid_actor_count bigint;
  invalid_semantic_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO orphan_order_count
  FROM public.order_events oe
  LEFT JOIN public.orders o
    ON o.id = oe.order_id
  WHERE o.id IS NULL;

  IF orphan_order_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % order_event row(s) with missing orders',
      orphan_order_count;
  END IF;

  SELECT COUNT(*)
  INTO orphan_restaurant_count
  FROM public.order_events oe
  LEFT JOIN public.restaurants r
    ON r.id = oe.restaurant_id
  WHERE r.id IS NULL;

  IF orphan_restaurant_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % order_event row(s) with missing restaurants',
      orphan_restaurant_count;
  END IF;

  SELECT COUNT(*)
  INTO orphan_actor_count
  FROM public.order_events oe
  LEFT JOIN public.users u
    ON u.id = oe.actor_user_id
  WHERE oe.actor_user_id IS NOT NULL
    AND u.id IS NULL;

  IF orphan_actor_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % order_event row(s) with missing actor users',
      orphan_actor_count;
  END IF;

  SELECT COUNT(*)
  INTO tenant_mismatch_count
  FROM public.order_events oe
  JOIN public.orders o
    ON o.id = oe.order_id
  WHERE oe.restaurant_id IS DISTINCT FROM o.restaurant_id;

  IF tenant_mismatch_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % order_event tenant mismatch(es)',
      tenant_mismatch_count;
  END IF;

  SELECT COUNT(*)
  INTO invalid_meta_count
  FROM public.order_events
  WHERE meta IS NULL
     OR jsonb_typeof(meta) <> 'object';

  IF invalid_meta_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % invalid order_event meta payload(s)',
      invalid_meta_count;
  END IF;

  SELECT COUNT(*)
  INTO invalid_actor_count
  FROM public.order_events
  WHERE
       (
         actor_type = 'USER'
         AND actor_user_id IS NULL
       )
    OR (
         actor_type <> 'USER'
         AND actor_user_id IS NOT NULL
       )
    OR (
         actor_type = 'CUSTOMER'
         AND (
           actor_firebase_uid IS NULL
           OR btrim(actor_firebase_uid) = ''
         )
       )
    OR (
         actor_type IN (
           'SYSTEM',
           'PAYMENT_PROVIDER'
         )
         AND actor_firebase_uid IS NOT NULL
       );

  IF invalid_actor_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % invalid order_event actor combination(s)',
      invalid_actor_count;
  END IF;

  SELECT COUNT(*)
  INTO invalid_semantic_count
  FROM public.order_events order_events
  WHERE
       (
         event_type = 'ORDER_CREATED'
         AND (
           from_status IS NOT NULL
           OR to_status IS DISTINCT FROM 'OPEN'
         )
       )
    OR (
         event_type = 'STATUS_CHANGED'
         AND (
           from_status IS NULL
           OR to_status IS NULL
           OR from_status IS NOT DISTINCT FROM to_status
         )
       )
    OR (
         event_type = 'RECALL'
         AND (
           from_status IS DISTINCT FROM 'READY'
           OR to_status IS DISTINCT FROM 'SENT'
         )
       )
    OR (
         event_type = 'ORDER_VOIDED'
         AND (
           from_status IS NULL
           OR to_status IS DISTINCT FROM 'CANCELLED'
           OR actor_type <> 'USER'
           OR NULLIF(btrim(meta ->> 'reason'), '') IS NULL
           OR COALESCE(
             NULLIF(btrim(meta ->> 'actor_role'), '') NOT IN (
               'Owner',
               'Manager'
             ),
             TRUE
           )
         )
       )
    OR (
         event_type = 'ORDER_COMPED'
         AND (
           actor_type <> 'USER'
           OR NULLIF(btrim(meta ->> 'reason'), '') IS NULL
           OR COALESCE(
             NULLIF(btrim(meta ->> 'actor_role'), '') NOT IN (
               'Owner',
               'Manager'
             ),
             TRUE
           )
           OR NOT (meta ? 'comped_cents')
           OR NOT (
                CASE
                  WHEN (meta ->> 'comped_cents') ~ '^[0-9]+$'
                    THEN
                      (meta ->> 'comped_cents')::bigint > 0
                      AND COALESCE(
                        meta ->> 'legacy_classification',
                        ''
                      ) <> 'NO_OP_COMP_ATTEMPT'
                  ELSE FALSE
                END
                OR (
                   id IN (
                     'ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid,
                     '5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid,
                     '7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid,
                     '4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid,
                     'b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid,
                     'beb12727-d987-462d-bf83-ca19528eed7c'::uuid
                   )
                   AND meta ->> 'comped_cents' IS NOT DISTINCT FROM '0'
                   AND meta ->> 'legacy_classification'
                     IS NOT DISTINCT FROM 'NO_OP_COMP_ATTEMPT'
                 )
              )
         )
       )
    OR (
         event_type = 'ORDER_OVERRIDE'
         AND (
           actor_type <> 'USER'
           OR from_status IS NULL
           OR to_status IS NULL
           OR from_status IS NOT DISTINCT FROM to_status
           OR NULLIF(btrim(meta ->> 'reason'), '') IS NULL
           OR COALESCE(
             NULLIF(btrim(meta ->> 'actor_role'), '') NOT IN (
               'Owner',
               'Manager'
             ),
             TRUE
           )
         )
       )
    OR (
         event_type = 'PAYMENT_RECORDED'
         AND (
           actor_type <> 'PAYMENT_PROVIDER'
           OR (
                NULLIF(btrim(idempotency_key), '') IS NULL
                AND id NOT IN (
                  '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid,
                  '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid
                )
              )
           OR NULLIF(btrim(meta ->> 'provider'), '') IS NULL
           OR COALESCE(
                meta ->> 'provider' NOT IN (
                  'STRIPE',
                  'LEGACY_CUSTOMER_CHECKOUT'
                ),
                TRUE
              )
           OR NULLIF(
             btrim(meta ->> 'payment_reference'),
             ''
           ) IS NULL
           OR NOT (meta ? 'amount_cents')
           OR CASE
                WHEN (meta ->> 'amount_cents') ~ '^[0-9]+$'
                  THEN (meta ->> 'amount_cents')::bigint <= 0
                ELSE TRUE
              END
           OR (
                meta ->> 'provider' = 'LEGACY_CUSTOMER_CHECKOUT'
                AND (
                  meta ->> 'legacy_classification'
                    IS DISTINCT FROM 'LEGACY_CUSTOMER_CHECKOUT'
                  OR meta ->> 'payment_reference'
                    IS DISTINCT FROM (
                      'legacy-order:' || order_events.order_id::text
                    )
                )
              )
         )
       );

  IF invalid_semantic_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % order_event semantic violation(s)',
      invalid_semantic_count;
  END IF;
END;
$$;

ALTER TABLE public.order_events
  ALTER COLUMN event_type SET NOT NULL,
  ALTER COLUMN actor_type SET NOT NULL,
  ALTER COLUMN meta SET DEFAULT '{}'::jsonb,
  ALTER COLUMN meta SET NOT NULL;

ALTER TABLE public.order_events
  DROP CONSTRAINT IF EXISTS order_events_order_id_fkey,
  DROP CONSTRAINT IF EXISTS order_events_restaurant_id_fkey,
  DROP CONSTRAINT IF EXISTS order_events_actor_user_id_fkey,
  DROP CONSTRAINT IF EXISTS fk_order_events_restaurant_order,
  DROP CONSTRAINT IF EXISTS fk_order_events_restaurant,
  DROP CONSTRAINT IF EXISTS fk_order_events_actor_user,
  DROP CONSTRAINT IF EXISTS chk_order_events_meta_object,
  DROP CONSTRAINT IF EXISTS chk_order_events_actor_consistency,
  DROP CONSTRAINT IF EXISTS chk_order_events_semantics;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class c
      ON c.oid = con.conrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND con.contype IN ('p', 'u')
      AND con.conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.orders'::regclass
            AND attname = 'restaurant_id'
            AND NOT attisdropped
        ),
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.orders'::regclass
            AND attname = 'id'
            AND NOT attisdropped
        )
      ]::smallint[]
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT uq_orders_restaurant_id_id
      UNIQUE (restaurant_id, id);
  END IF;
END;
$$;

-- Fail closed if the existing financial event ledger already exceeds
-- the authoritative order total before runtime enforcement is installed.
DO $$
DECLARE
  invalid_order_count bigint;
BEGIN
  WITH financial_event_totals AS (
    SELECT
      order_events.restaurant_id,
      order_events.order_id,
      SUM(
        CASE
          WHEN order_events.event_type = 'PAYMENT_RECORDED'
            AND (
              order_events.meta ->> 'amount_cents'
            ) ~ '^[0-9]+$'
            THEN (
              order_events.meta ->> 'amount_cents'
            )::bigint

          WHEN order_events.event_type = 'ORDER_COMPED'
            AND (
              order_events.meta ->> 'comped_cents'
            ) ~ '^[0-9]+$'
            AND (
              order_events.meta ->> 'comped_cents'
            )::bigint > 0
            THEN (
              order_events.meta ->> 'comped_cents'
            )::bigint

          ELSE 0
        END
      ) AS financial_event_cents
    FROM public.order_events order_events
    WHERE order_events.event_type IN (
      'ORDER_COMPED',
      'PAYMENT_RECORDED'
    )
    GROUP BY
      order_events.restaurant_id,
      order_events.order_id
  )
  SELECT COUNT(*)
  INTO invalid_order_count
  FROM financial_event_totals financial_events
  JOIN public.orders orders
    ON orders.id = financial_events.order_id
   AND orders.restaurant_id = financial_events.restaurant_id
  WHERE financial_events.financial_event_cents
    > orders.total_cents::bigint;

  IF invalid_order_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % order(s) whose cumulative financial event ledger exceeds the authoritative order total',
      invalid_order_count;
  END IF;
END;
$$;

-- Enforce authoritative order totals for financial lifecycle events.
CREATE OR REPLACE FUNCTION public.enforce_order_event_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_total_cents bigint;
  event_amount_cents bigint;
  existing_financial_event_cents bigint;
BEGIN
  IF NEW.event_type NOT IN (
    'ORDER_COMPED',
    'PAYMENT_RECORDED'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT orders.total_cents::bigint
  INTO authoritative_total_cents
  FROM public.orders orders
  WHERE orders.id = NEW.order_id
    AND orders.restaurant_id = NEW.restaurant_id
  FOR NO KEY UPDATE;

  IF authoritative_total_cents IS NULL THEN
    RAISE EXCEPTION
      'Order event references an unavailable authoritative order total';
  END IF;

  IF NEW.event_type = 'ORDER_COMPED' THEN
    IF NOT (
      (NEW.meta ->> 'comped_cents') ~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION
        'ORDER_COMPED comped_cents must be a nonnegative integer string';
    END IF;

    event_amount_cents :=
      (NEW.meta ->> 'comped_cents')::bigint;

    IF event_amount_cents <= 0 THEN
      RAISE EXCEPTION
        'ORDER_COMPED comped_cents % must be greater than zero',
        event_amount_cents;
    END IF;

  ELSIF NEW.event_type = 'PAYMENT_RECORDED' THEN
    IF NOT (
      (NEW.meta ->> 'amount_cents') ~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION
        'PAYMENT_RECORDED amount_cents must be a nonnegative integer string';
    END IF;

    event_amount_cents :=
      (NEW.meta ->> 'amount_cents')::bigint;

    IF event_amount_cents <= 0 THEN
      RAISE EXCEPTION
        'PAYMENT_RECORDED amount_cents % must be greater than zero',
        event_amount_cents;
    END IF;
  END IF;

  SELECT COALESCE(
    SUM(
      CASE
        WHEN order_events.event_type = 'PAYMENT_RECORDED'
          AND (
            order_events.meta ->> 'amount_cents'
          ) ~ '^[0-9]+$'
          THEN (
            order_events.meta ->> 'amount_cents'
          )::bigint

        WHEN order_events.event_type = 'ORDER_COMPED'
          AND (
            order_events.meta ->> 'comped_cents'
          ) ~ '^[0-9]+$'
          AND (
            order_events.meta ->> 'comped_cents'
          )::bigint > 0
          THEN (
            order_events.meta ->> 'comped_cents'
          )::bigint

        ELSE 0
      END
    ),
    0
  )
  INTO existing_financial_event_cents
  FROM public.order_events order_events
  WHERE order_events.order_id = NEW.order_id
    AND order_events.restaurant_id = NEW.restaurant_id
    AND order_events.event_type IN (
      'ORDER_COMPED',
      'PAYMENT_RECORDED'
    )
    AND order_events.id IS DISTINCT FROM NEW.id;

  IF (
    existing_financial_event_cents
    + event_amount_cents
  ) > authoritative_total_cents THEN
    RAISE EXCEPTION
      'Cumulative financial event amount % exceeds authoritative order total %',
      existing_financial_event_cents + event_amount_cents,
      authoritative_total_cents;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_order_event_amount
  ON public.order_events;

CREATE TRIGGER trg_enforce_order_event_amount
BEFORE INSERT OR UPDATE OF
  event_type,
  order_id,
  restaurant_id,
  meta
ON public.order_events
FOR EACH ROW
EXECUTE FUNCTION public.enforce_order_event_amount();


-- Prevent authoritative order totals from drifting after financial events exist.
CREATE OR REPLACE FUNCTION public.prevent_order_total_drift()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.total_cents IS NOT DISTINCT FROM OLD.total_cents THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_events order_events
    WHERE order_events.order_id = OLD.id
      AND order_events.restaurant_id = OLD.restaurant_id
      AND (
        order_events.event_type = 'PAYMENT_RECORDED'
        OR (
          order_events.event_type = 'ORDER_COMPED'
          AND (order_events.meta ->> 'comped_cents') ~ '^[0-9]+$'
          AND (order_events.meta ->> 'comped_cents')::bigint > 0
        )
      )
  ) THEN
    RAISE EXCEPTION
      'orders.total_cents cannot change after payment or positive comp events exist';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_order_total_drift
  ON public.orders;

CREATE TRIGGER trg_prevent_order_total_drift
BEFORE UPDATE OF total_cents
ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.prevent_order_total_drift();


ALTER TABLE public.order_events
  ADD CONSTRAINT fk_order_events_restaurant_order
    FOREIGN KEY (restaurant_id, order_id)
    REFERENCES public.orders (restaurant_id, id)
    ON DELETE RESTRICT,

  ADD CONSTRAINT fk_order_events_restaurant
    FOREIGN KEY (restaurant_id)
    REFERENCES public.restaurants (id)
    ON DELETE RESTRICT,

  ADD CONSTRAINT fk_order_events_actor_user
    FOREIGN KEY (actor_user_id)
    REFERENCES public.users (id)
    ON DELETE RESTRICT,

  ADD CONSTRAINT chk_order_events_meta_object
    CHECK (jsonb_typeof(meta) = 'object'),

  ADD CONSTRAINT chk_order_events_actor_consistency
    CHECK (
         (
           actor_type = 'USER'
           AND actor_user_id IS NOT NULL
         )
      OR (
           actor_type = 'CUSTOMER'
           AND actor_user_id IS NULL
           AND actor_firebase_uid IS NOT NULL
           AND btrim(actor_firebase_uid) <> ''
         )
      OR (
           actor_type IN (
             'SYSTEM',
             'PAYMENT_PROVIDER'
           )
           AND actor_user_id IS NULL
           AND actor_firebase_uid IS NULL
         )
    ),

  ADD CONSTRAINT chk_order_events_semantics
    CHECK (
         (
           event_type = 'ORDER_CREATED'
           AND from_status IS NULL
           AND to_status IS NOT DISTINCT FROM 'OPEN'
         )
      OR (
           event_type = 'STATUS_CHANGED'
           AND from_status IS NOT NULL
           AND to_status IS NOT NULL
           AND from_status <> to_status
         )
      OR (
           event_type = 'RECALL'
           AND from_status IS NOT DISTINCT FROM 'READY'
           AND to_status IS NOT DISTINCT FROM 'SENT'
         )
      OR (
           event_type = 'ORDER_VOIDED'
           AND from_status IS NOT NULL
           AND to_status IS NOT DISTINCT FROM 'CANCELLED'
           AND actor_type = 'USER'
           AND NULLIF(btrim(meta ->> 'reason'), '') IS NOT NULL
           AND COALESCE(
             NULLIF(btrim(meta ->> 'actor_role'), '') IN (
               'Owner',
               'Manager'
             ),
             FALSE
           )
         )
      OR (
           event_type = 'ORDER_COMPED'
           AND actor_type = 'USER'
           AND NULLIF(btrim(meta ->> 'reason'), '') IS NOT NULL
           AND COALESCE(
             NULLIF(btrim(meta ->> 'actor_role'), '') IN (
               'Owner',
               'Manager'
             ),
             FALSE
           )
           AND meta ? 'comped_cents'
           AND (
                 (
                   CASE
                     WHEN (
                       meta ->> 'comped_cents'
                     ) ~ '^[0-9]+$'
                       THEN (
                         meta ->> 'comped_cents'
                       )::bigint > 0
                     ELSE FALSE
                   END
                   AND COALESCE(
                     meta ->> 'legacy_classification',
                     ''
                   ) <> 'NO_OP_COMP_ATTEMPT'
                 )
                 OR (
                     id IN (
                       'ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid,
                       '5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid,
                       '7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid,
                       '4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid,
                       'b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid,
                       'beb12727-d987-462d-bf83-ca19528eed7c'::uuid
                     )
                     AND meta ->> 'comped_cents' IS NOT DISTINCT FROM '0'
                     AND meta ->> 'legacy_classification'
                       IS NOT DISTINCT FROM 'NO_OP_COMP_ATTEMPT'
                   )
               )
         )
      OR (
           event_type = 'ORDER_OVERRIDE'
           AND actor_type = 'USER'
           AND from_status IS NOT NULL
           AND to_status IS NOT NULL
           AND from_status <> to_status
           AND NULLIF(btrim(meta ->> 'reason'), '') IS NOT NULL
           AND COALESCE(
             NULLIF(btrim(meta ->> 'actor_role'), '') IN (
               'Owner',
               'Manager'
             ),
             FALSE
           )
         )
      OR (
           event_type = 'PAYMENT_RECORDED'
           AND actor_type = 'PAYMENT_PROVIDER'
           AND (
                NULLIF(btrim(idempotency_key), '') IS NOT NULL
                OR id IN (
                  '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid,
                  '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid
                )
              )
           AND NULLIF(btrim(meta ->> 'provider'), '') IS NOT NULL
           AND COALESCE(
             meta ->> 'provider' IN (
               'STRIPE',
               'LEGACY_CUSTOMER_CHECKOUT'
             ),
             FALSE
           )
           AND NULLIF(
             btrim(meta ->> 'payment_reference'),
             ''
           ) IS NOT NULL
           AND (
                 meta ->> 'provider' <> 'LEGACY_CUSTOMER_CHECKOUT'
                 OR (
                   meta ->> 'legacy_classification'
                     IS NOT DISTINCT FROM 'LEGACY_CUSTOMER_CHECKOUT'
                   AND meta ->> 'payment_reference'
                     = 'legacy-order:' || order_id::text
                   AND idempotency_key
                     = 'legacy-payment:' || order_id::text
                 )
               )
           AND meta ? 'amount_cents'
           AND CASE
                 WHEN (
                   meta ->> 'amount_cents'
                 ) ~ '^[0-9]+$'
                   THEN (
                     meta ->> 'amount_cents'
                   )::bigint > 0
                 ELSE FALSE
               END
         )
    );

CREATE INDEX IF NOT EXISTS idx_order_events_order_timeline
  ON public.order_events (
    order_id,
    created_at,
    id
  );

CREATE INDEX IF NOT EXISTS idx_order_events_restaurant_timeline
  ON public.order_events (
    restaurant_id,
    created_at,
    id
  );

DO $$
DECLARE
  duplicate_idempotency_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.order_events
    WHERE idempotency_key IS NOT NULL
      AND btrim(idempotency_key) = ''
  ) THEN
    RAISE EXCEPTION
      'Phase 40F migration found blank order_event idempotency keys';
  END IF;

  SELECT COUNT(*)
  INTO duplicate_idempotency_count
  FROM (
    SELECT
      restaurant_id,
      order_id,
      event_type,
      idempotency_key
    FROM public.order_events
    WHERE idempotency_key IS NOT NULL
    GROUP BY
      restaurant_id,
      order_id,
      event_type,
      idempotency_key
    HAVING COUNT(*) > 1
  ) duplicate_scopes;

  IF duplicate_idempotency_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40F migration found % duplicate order_event idempotency scope(s)',
      duplicate_idempotency_count;
  END IF;
END;
$$;

ALTER TABLE public.order_events
  DROP CONSTRAINT IF EXISTS
    chk_order_events_idempotency_key_nonblank;

ALTER TABLE public.order_events
  ADD CONSTRAINT chk_order_events_idempotency_key_nonblank
    CHECK (
      idempotency_key IS NULL
      OR btrim(idempotency_key) <> ''
    );

DROP INDEX IF EXISTS public.uq_order_events_idempotency;

CREATE UNIQUE INDEX uq_order_events_idempotency
  ON public.order_events (
    restaurant_id,
    order_id,
    event_type,
    idempotency_key
  )
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- SECTION E — Remove legacy lifecycle, payment, and event writers
-- ============================================================================

-- Remove every known lifecycle transition trigger.
DROP TRIGGER IF EXISTS
  trg_dine_enforce_order_status_transitions
ON public.orders;

DROP TRIGGER IF EXISTS
  trg_enforce_order_status_transition
ON public.orders;

-- Remove any previously attempted canonical lifecycle trigger.
DROP TRIGGER IF EXISTS
  trg_dine_canonical_order_lifecycle
ON public.orders;

-- Remove the legacy paid-before-SENT trigger and any prior replacement.
DROP TRIGGER IF EXISTS
  trg_dine_enforce_paid_before_sent
ON public.orders;

DROP TRIGGER IF EXISTS
  trg_dine_enforce_order_send_eligibility
ON public.orders;

-- Remove any previously attempted lifecycle timestamp validator.
DROP TRIGGER IF EXISTS
  trg_dine_enforce_order_lifecycle_timestamps
ON public.orders;

-- Remove database-owned order event writers.
-- Application services will become authoritative for semantic order_events.
DROP TRIGGER IF EXISTS
  trg_dine_log_order_events_insert
ON public.orders;

DROP TRIGGER IF EXISTS
  trg_dine_log_order_events_update
ON public.orders;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(c.relname) AS table_name,
      quote_ident(t.tgname) AS trigger_name
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    JOIN pg_proc p
      ON p.oid = t.tgfoid
    JOIN pg_namespace pn
      ON pn.oid = p.pronamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
      AND c.relname = 'orders'
      AND pn.nspname = 'public'
      AND p.proname IN (
        'dine_enforce_order_status_transitions',
        'enforce_order_status_transition',
        'dine_enforce_paid_before_sent',
        'dine_log_order_events',
        'dine_enforce_canonical_order_lifecycle',
        'dine_enforce_order_send_eligibility',
        'dine_enforce_order_lifecycle_timestamps'
      )
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %s ON %s.%s',
      r.trigger_name,
      r.schema_name,
      r.table_name
    );
  END LOOP;
END;
$$;

-- Remove obsolete lifecycle functions after their triggers are detached.
DROP FUNCTION IF EXISTS
  public.dine_enforce_order_status_transitions();

DROP FUNCTION IF EXISTS
  public.enforce_order_status_transition();

DROP FUNCTION IF EXISTS
  public.dine_enforce_canonical_order_lifecycle();

-- Remove any prior lifecycle timestamp validator.
DROP FUNCTION IF EXISTS
  public.dine_enforce_order_lifecycle_timestamps();

-- Remove obsolete payment eligibility functions.
DROP FUNCTION IF EXISTS
  public.dine_enforce_paid_before_sent();

DROP FUNCTION IF EXISTS
  public.dine_enforce_order_send_eligibility();

-- Remove the obsolete database event-writing function.
DROP FUNCTION IF EXISTS
  public.dine_log_order_events();


-- ============================================================================
-- SECTION F — Canonical full-settlement eligibility for SENT
-- ============================================================================

CREATE FUNCTION public.dine_enforce_order_send_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('SENT', 'READY', 'CLOSED')
     AND (
       COALESCE(NEW.paid_cents, 0)
       + COALESCE(NEW.comped_cents, 0)
     ) < COALESCE(NEW.total_cents, 0)
  THEN
    RAISE EXCEPTION
      'Order cannot remain beyond OPEN unless financially settled (status %, paid_cents %, comped_cents %, total_cents %)',
      NEW.status,
      NEW.paid_cents,
      NEW.comped_cents,
      NEW.total_cents
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dine_enforce_order_send_eligibility
BEFORE INSERT OR UPDATE OF
  status,
  paid_cents,
  comped_cents,
  total_cents
ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.dine_enforce_order_send_eligibility();


-- ============================================================================
-- SECTION G — Canonical lifecycle function and transition trigger
-- ============================================================================

CREATE FUNCTION public.dine_enforce_canonical_order_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION
        'New orders must be created in OPEN status'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- Same-state retries are allowed as database no-ops.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Canonical send: OPEN -> SENT.
  IF OLD.status = 'OPEN'
     AND NEW.status = 'SENT'
  THEN
    NEW.sent_at := COALESCE(NEW.sent_at, now());
    NEW.ready_at := NULL;
    NEW.closed_at := NULL;
    RETURN NEW;
  END IF;

  -- Kitchen completion: SENT -> READY.
  IF OLD.status = 'SENT'
     AND NEW.status = 'READY'
  THEN
    NEW.ready_at := now();
    NEW.closed_at := NULL;
    RETURN NEW;
  END IF;

  -- Manager recall: READY -> SENT.
  IF OLD.status = 'READY'
     AND NEW.status = 'SENT'
  THEN
    NEW.sent_at := COALESCE(NEW.sent_at, now());
    NEW.ready_at := NULL;
    NEW.recalled_at := now();
    NEW.closed_at := NULL;
    RETURN NEW;
  END IF;

  -- Canonical close: READY -> CLOSED.
  IF OLD.status = 'READY'
     AND NEW.status = 'CLOSED'
  THEN
    NEW.closed_at := now();
    RETURN NEW;
  END IF;

  -- Exceptional terminal cancellation.
  IF OLD.status IN ('OPEN', 'SENT', 'READY')
     AND NEW.status = 'CANCELLED'
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Illegal canonical order lifecycle transition: % -> %',
    OLD.status,
    NEW.status
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER trg_dine_canonical_order_lifecycle
BEFORE INSERT OR UPDATE OF status
ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.dine_enforce_canonical_order_lifecycle();


-- ============================================================================
-- Permanent lifecycle timestamp integrity
-- ============================================================================

CREATE FUNCTION public.dine_enforce_order_lifecycle_timestamps()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- OPEN has not entered the kitchen lifecycle.
  IF NEW.status = 'OPEN'
     AND (
       NEW.sent_at IS NOT NULL
       OR NEW.ready_at IS NOT NULL
       OR NEW.recalled_at IS NOT NULL
       OR NEW.closed_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'OPEN order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  -- SENT includes both first send and manager recall.
  -- A recalled order may retain recalled_at, but ready_at must be cleared.
  IF NEW.status = 'SENT'
     AND (
       NEW.sent_at IS NULL
       OR NEW.ready_at IS NOT NULL
       OR NEW.closed_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'SENT order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'READY'
     AND (
       NEW.sent_at IS NULL
       OR NEW.ready_at IS NULL
       OR NEW.closed_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'READY order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CLOSED'
     AND (
       NEW.sent_at IS NULL
       OR NEW.ready_at IS NULL
       OR NEW.closed_at IS NULL
     )
  THEN
    RAISE EXCEPTION
      'CLOSED order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  -- CANCELLED preserves any legitimate prior sent/ready history.
  -- It is not a successful close and therefore cannot have closed_at.
  IF NEW.status = 'CANCELLED'
     AND (
       NEW.closed_at IS NOT NULL
       OR (
         NEW.ready_at IS NOT NULL
         AND NEW.sent_at IS NULL
       )
     )
  THEN
    RAISE EXCEPTION
      'CANCELLED order cannot have closed_at'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dine_enforce_order_lifecycle_timestamps
BEFORE INSERT OR UPDATE OF
  status,
  sent_at,
  ready_at,
  recalled_at,
  closed_at
ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.dine_enforce_order_lifecycle_timestamps();


-- ============================================================================
-- SECTION H — Final catalog assertions
-- ============================================================================

DO $$
DECLARE
  lifecycle_trigger_count integer;
  required_event_count integer;
  missing_columns text[] := ARRAY[]::text[];
BEGIN
  SELECT COUNT(*)
  INTO lifecycle_trigger_count
  FROM pg_trigger t
  JOIN pg_class c
    ON c.oid = t.tgrelid
  JOIN pg_namespace n
    ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'orders'
    AND NOT t.tgisinternal
    AND t.tgname IN (
      'trg_dine_enforce_order_status_transitions',
      'trg_enforce_order_status_transition',
      'trg_dine_canonical_order_lifecycle'
    );

  IF lifecycle_trigger_count <> 1 THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: expected exactly one lifecycle trigger, found %',
      lifecycle_trigger_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    JOIN pg_proc p
      ON p.oid = t.tgfoid
    JOIN pg_namespace pn
      ON pn.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND NOT t.tgisinternal
      AND pn.nspname = 'public'
      AND p.proname IN (
        'dine_enforce_order_status_transitions',
        'enforce_order_status_transition',
        'dine_enforce_canonical_order_lifecycle'
      )
      AND t.tgname <> 'trg_dine_canonical_order_lifecycle'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: competing lifecycle trigger remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND t.tgname = 'trg_dine_canonical_order_lifecycle'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: canonical lifecycle trigger is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND NOT t.tgisinternal
      AND t.tgname IN (
        'trg_dine_enforce_order_status_transitions',
        'trg_enforce_order_status_transition',
        'trg_dine_log_order_events_insert',
        'trg_dine_log_order_events_update'
      )
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: legacy lifecycle or event trigger remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND t.tgname = 'trg_dine_enforce_order_send_eligibility'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: send-eligibility trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    JOIN pg_proc p
      ON p.oid = t.tgfoid
    JOIN pg_namespace pn
      ON pn.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND t.tgname = 'trg_dine_canonical_order_lifecycle'
      AND pn.nspname = 'public'
      AND p.proname = 'dine_enforce_canonical_order_lifecycle'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: canonical lifecycle trigger invokes the wrong function';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    JOIN pg_proc p
      ON p.oid = t.tgfoid
    JOIN pg_namespace pn
      ON pn.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND t.tgname = 'trg_dine_enforce_order_send_eligibility'
      AND pn.nspname = 'public'
      AND p.proname = 'dine_enforce_order_send_eligibility'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: send-eligibility trigger invokes the wrong function';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND t.tgname = 'trg_dine_canonical_order_lifecycle'
      AND NOT t.tgisinternal
      AND pg_get_triggerdef(t.oid) ILIKE
        '%BEFORE INSERT OR UPDATE OF status ON public.orders%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: canonical lifecycle trigger event definition is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND t.tgname = 'trg_dine_enforce_order_send_eligibility'
      AND NOT t.tgisinternal
      AND pg_get_triggerdef(t.oid) ILIKE '%BEFORE INSERT OR UPDATE%'
      AND pg_get_triggerdef(t.oid) ILIKE '%status%'
      AND pg_get_triggerdef(t.oid) ILIKE '%paid_cents%'
      AND pg_get_triggerdef(t.oid) ILIKE '%comped_cents%'
      AND pg_get_triggerdef(t.oid) ILIKE '%total_cents%'
      AND pg_get_triggerdef(t.oid) ILIKE '%ON public.orders%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: send-eligibility trigger event definition is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    JOIN pg_proc p
      ON p.oid = t.tgfoid
    JOIN pg_namespace pn
      ON pn.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND t.tgname = 'trg_dine_enforce_order_lifecycle_timestamps'
      AND NOT t.tgisinternal
      AND pn.nspname = 'public'
      AND p.proname = 'dine_enforce_order_lifecycle_timestamps'
      AND pg_get_triggerdef(t.oid) ILIKE '%BEFORE INSERT OR UPDATE%'
      AND pg_get_triggerdef(t.oid) ILIKE '%status%'
      AND pg_get_triggerdef(t.oid) ILIKE '%sent_at%'
      AND pg_get_triggerdef(t.oid) ILIKE '%ready_at%'
      AND pg_get_triggerdef(t.oid) ILIKE '%recalled_at%'
      AND pg_get_triggerdef(t.oid) ILIKE '%closed_at%'
      AND pg_get_triggerdef(t.oid) ILIKE '%ON public.orders%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: lifecycle timestamp trigger definition is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'order_origin'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'order_origin'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'table_id'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'table_id'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'recalled_at'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'recalled_at'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'comped_cents'
  ) THEN
    missing_columns := array_append(
      missing_columns,
      'comped_cents'
    );
  END IF;

  IF cardinality(missing_columns) > 0 THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: missing normalized order column(s): %',
      array_to_string(missing_columns, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'order_origin'
      AND udt_schema = 'public'
      AND udt_name = 'order_origin'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: orders.order_origin is not public.order_origin';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'order_origin'
      AND udt_schema = 'public'
      AND udt_name = 'order_origin'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: orders.order_origin remains nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'table_id'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: orders.table_id is not text';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'total_cents'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: orders.total_cents remains nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'paid_cents'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: orders.paid_cents remains nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'comped_cents'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: orders.comped_cents remains nullable';
  END IF;

  IF (
    SELECT COUNT(DISTINCT con.conname)
    FROM pg_constraint con
    JOIN pg_class c
      ON c.oid = con.conrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'orders'
      AND con.conname IN (
        'chk_orders_total_cents_nonnegative',
        'chk_orders_paid_cents_nonnegative',
        'chk_orders_comped_cents_nonnegative',
        'chk_orders_paid_not_over_total',
        'chk_orders_comped_not_over_total',
        'chk_orders_settlement_not_over_total'
      )
  ) <> 6 THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: one or more financial constraints are missing';
  END IF;

  SELECT COUNT(DISTINCT e.enumlabel)
  INTO required_event_count
  FROM pg_type t
  JOIN pg_namespace n
    ON n.oid = t.typnamespace
  JOIN pg_enum e
    ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
    AND t.typname = 'order_event_type'
    AND e.enumlabel IN (
      'ORDER_CREATED',
      'PAYMENT_RECORDED',
      'STATUS_CHANGED',
      'RECALL',
      'ORDER_VOIDED',
      'ORDER_COMPED',
      'ORDER_OVERRIDE'
    );

  IF required_event_count <> 7 THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: expected 7 canonical event values, found %',
      required_event_count;
  END IF;

  IF to_regprocedure(
    'public.dine_enforce_order_status_transitions()'
  ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: legacy dine_enforce_order_status_transitions() remains';
  END IF;

  IF to_regprocedure(
    'public.enforce_order_status_transition()'
  ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: legacy enforce_order_status_transition() remains';
  END IF;

  IF to_regprocedure(
    'public.dine_enforce_paid_before_sent()'
  ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: legacy dine_enforce_paid_before_sent() remains';
  END IF;

  IF to_regprocedure(
    'public.dine_log_order_events()'
  ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: legacy dine_log_order_events() remains';
  END IF;

  IF to_regprocedure(
    'public.dine_enforce_canonical_order_lifecycle()'
  ) IS NULL THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: canonical lifecycle function is missing';
  END IF;

  IF to_regprocedure(
    'public.dine_enforce_order_send_eligibility()'
  ) IS NULL THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: send-eligibility function is missing';
  END IF;

  IF to_regprocedure(
    'public.dine_enforce_order_lifecycle_timestamps()'
  ) IS NULL THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: lifecycle timestamp function is missing';
  END IF;

  IF ARRAY(
    SELECT e.enumlabel::text
    FROM pg_enum e
    JOIN pg_type t
      ON t.oid = e.enumtypid
    JOIN pg_namespace n
      ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'order_event_type'
    ORDER BY e.enumsortorder
  ) IS DISTINCT FROM ARRAY[
    'ORDER_CREATED',
    'PAYMENT_RECORDED',
    'STATUS_CHANGED',
    'RECALL',
    'ORDER_VOIDED',
    'ORDER_COMPED',
    'ORDER_OVERRIDE'
  ]::text[] THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order_event_type is not canonical';
  END IF;

  IF ARRAY(
    SELECT e.enumlabel::text
    FROM pg_enum e
    JOIN pg_type t
      ON t.oid = e.enumtypid
    JOIN pg_namespace n
      ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'order_actor_type'
    ORDER BY e.enumsortorder
  ) IS DISTINCT FROM ARRAY[
    'USER',
    'CUSTOMER',
    'SYSTEM',
    'PAYMENT_PROVIDER'
  ]::text[] THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order_actor_type is not canonical';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'metadata'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: legacy order_events.metadata remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'event_type'
      AND udt_schema = 'public'
      AND udt_name = 'order_event_type'
      AND is_nullable = 'NO'
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: event_type column contract is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'actor_type'
      AND udt_schema = 'public'
      AND udt_name = 'order_actor_type'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: actor_type column contract is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'actor_firebase_uid'
      AND data_type = 'text'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: actor_firebase_uid contract is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'idempotency_key'
      AND data_type = 'text'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: idempotency_key contract is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'meta'
      AND data_type = 'jsonb'
      AND is_nullable = 'NO'
      AND column_default = '''{}''::jsonb'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: meta column contract is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname = 'fk_order_events_restaurant_order'
      AND con.contype = 'f'
      AND con.confrelid = 'public.orders'::regclass
      AND con.conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.order_events'::regclass
            AND attname = 'restaurant_id'
            AND NOT attisdropped
        ),
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.order_events'::regclass
            AND attname = 'order_id'
            AND NOT attisdropped
        )
      ]::smallint[]
      AND con.confkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.orders'::regclass
            AND attname = 'restaurant_id'
            AND NOT attisdropped
        ),
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.orders'::regclass
            AND attname = 'id'
            AND NOT attisdropped
        )
      ]::smallint[]
      AND con.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: restaurant/order FK is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname = 'fk_order_events_restaurant'
      AND con.contype = 'f'
      AND con.confrelid = 'public.restaurants'::regclass
      AND con.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: restaurant FK is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname = 'fk_order_events_actor_user'
      AND con.contype = 'f'
      AND con.confrelid = 'public.users'::regclass
      AND con.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: actor-user FK is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname = 'chk_order_events_meta_object'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) = 'CHECK (jsonb_typeof(meta) = ''object''::text)'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: meta-object check is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname =
        'chk_order_events_idempotency_key_nonblank'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%idempotency_key IS NULL%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%btrim(idempotency_key) <> ''''%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: idempotency-key check is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname = 'chk_order_events_actor_consistency'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%actor_type = ''USER''%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%actor_type = ''CUSTOMER''%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%PAYMENT_PROVIDER%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%btrim(actor_firebase_uid) <> ''''%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: actor consistency check is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname = 'chk_order_events_semantics'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%PAYMENT_RECORDED%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%payment_reference%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%amount_cents%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%actor_role%'
      AND pg_get_constraintdef(
        con.oid,
        true
      ) ILIKE '%comped_cents%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: event semantics check is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'enforce_order_event_amount'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order-event amount function is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.order_events'::regclass
      AND t.tgname = 'trg_enforce_order_event_amount'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order-event amount trigger is missing';
  END IF;


  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'prevent_order_total_drift'
      AND p.prorettype = 'pg_catalog.trigger'::regtype
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order-total drift function is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_proc p
      ON p.oid = t.tgfoid
    JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE t.tgrelid = 'public.orders'::regclass
      AND t.tgname = 'trg_prevent_order_total_drift'
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
      AND n.nspname = 'public'
      AND p.proname = 'prevent_order_total_drift'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order-total drift trigger is missing';
  END IF;


  IF pg_get_functiondef(
       'public.enforce_order_event_amount()'::regprocedure
     ) NOT LIKE '%FOR NO KEY UPDATE%'
  THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order-event amount function lacks order-row serialization';
  END IF;

  IF pg_get_functiondef(
       'public.enforce_order_event_amount()'::regprocedure
     ) LIKE '%pg_advisory_xact_lock%'
  THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order-event amount function retains advisory serialization';
  END IF;

  IF pg_get_functiondef(
       'public.prevent_order_total_drift()'::regprocedure
     ) LIKE '%pg_advisory_xact_lock%'
  THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: order-total drift function retains advisory serialization';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indexrelid =
      'public.uq_order_events_idempotency'::regclass
      AND i.indrelid = 'public.order_events'::regclass
      AND i.indisunique
      AND i.indnkeyatts = 4
      AND ARRAY(
        SELECT key_attribute_number
        FROM unnest(i.indkey::smallint[])
          WITH ORDINALITY AS keys(key_attribute_number, position)
        ORDER BY position
      ) = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.order_events'::regclass
            AND attname = 'restaurant_id'
            AND NOT attisdropped
        ),
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.order_events'::regclass
            AND attname = 'order_id'
            AND NOT attisdropped
        ),
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.order_events'::regclass
            AND attname = 'event_type'
            AND NOT attisdropped
        ),
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'public.order_events'::regclass
            AND attname = 'idempotency_key'
            AND NOT attisdropped
        )
      ]::smallint[]
      AND pg_get_expr(
        i.indpred,
        i.indrelid
      ) = '(idempotency_key IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: idempotency index is not exact';
  END IF;

  IF to_regclass(
       'public.idx_order_events_order_timeline'
     ) IS NULL
     OR to_regclass(
       'public.idx_order_events_restaurant_timeline'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'Phase 40F assertion failed: timeline indexes are incomplete';
  END IF;

END;
$$;

COMMIT;
