BEGIN;

-- ============================================================================
-- Phase 40K — Restaurant and table registry
--
-- Establishes the authoritative restaurant-active and restaurant-table
-- ownership contracts required by public table-session verification.
-- ============================================================================

SELECT pg_advisory_xact_lock(
  hashtextextended('018_restaurant_table_registry', 0)
);

DO $$
BEGIN
  IF to_regclass('public.restaurants') IS NULL THEN
    RAISE EXCEPTION
      'Migration 018 prerequisite failed: public.restaurants is missing';
  END IF;

  IF to_regclass('public.table_sessions') IS NULL THEN
    RAISE EXCEPTION
      'Migration 018 prerequisite failed: public.table_sessions is missing';
  END IF;
END;
$$;

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS active boolean;

UPDATE public.restaurants
SET active = true
WHERE active IS NULL;

ALTER TABLE public.restaurants
  ALTER COLUMN active SET DEFAULT true,
  ALTER COLUMN active SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  table_id text NOT NULL,
  display_name text NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_restaurant_tables_restaurant
    FOREIGN KEY (restaurant_id)
    REFERENCES public.restaurants(id)
    ON DELETE CASCADE,

  CONSTRAINT uq_restaurant_tables_restaurant_table
    UNIQUE (restaurant_id, table_id),

  CONSTRAINT chk_restaurant_tables_table_id
    CHECK (
      table_id = btrim(table_id)
      AND table_id ~ '^[A-Za-z0-9_-]{1,64}$'
    ),

  CONSTRAINT chk_restaurant_tables_display_name
    CHECK (
      display_name IS NULL
      OR (
        display_name = btrim(display_name)
        AND char_length(display_name) BETWEEN 1 AND 120
      )
    ),

  CONSTRAINT chk_restaurant_tables_updated_at
    CHECK (updated_at >= created_at)
);

INSERT INTO public.restaurant_tables (
  restaurant_id,
  table_id,
  display_name,
  active
)
SELECT DISTINCT
  source.restaurant_id,
  source.table_id,
  source.table_id,
  true
FROM (
  SELECT
    ts.restaurant_id,
    ts.table_id
  FROM public.table_sessions ts
  WHERE ts.table_id = btrim(ts.table_id)
    AND ts.table_id ~ '^[A-Za-z0-9_-]{1,64}$'

  UNION

  SELECT
    o.restaurant_id,
    o.table_id
  FROM public.orders o
  WHERE o.table_id IS NOT NULL
    AND o.table_id = btrim(o.table_id)
    AND o.table_id ~ '^[A-Za-z0-9_-]{1,64}$'
) source
ON CONFLICT (restaurant_id, table_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_restaurant_tables_active_lookup
  ON public.restaurant_tables (
    restaurant_id,
    table_id
  )
  WHERE active = true;

CREATE INDEX IF NOT EXISTS ix_restaurant_tables_restaurant
  ON public.restaurant_tables (
    restaurant_id,
    active,
    table_id
  );

CREATE OR REPLACE FUNCTION
  public.set_restaurant_tables_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  trg_restaurant_tables_updated_at
  ON public.restaurant_tables;

CREATE TRIGGER trg_restaurant_tables_updated_at
BEFORE UPDATE ON public.restaurant_tables
FOR EACH ROW
EXECUTE FUNCTION public.set_restaurant_tables_updated_at();

ALTER TABLE public.table_sessions
  DROP CONSTRAINT IF EXISTS
    fk_table_sessions_restaurant_table;

ALTER TABLE public.table_sessions
  ADD CONSTRAINT fk_table_sessions_restaurant_table
    FOREIGN KEY (restaurant_id, table_id)
    REFERENCES public.restaurant_tables(
      restaurant_id,
      table_id
    )
    ON UPDATE CASCADE
    ON DELETE RESTRICT;

COMMENT ON COLUMN public.restaurants.active IS
  'Whether the restaurant is available for production traffic and public table-session verification.';

COMMENT ON TABLE public.restaurant_tables IS
  'Authoritative restaurant-scoped physical table registry.';

COMMENT ON COLUMN public.restaurant_tables.active IS
  'Whether the table may be used for new and existing public table-session verification.';

DO $$
DECLARE
  missing_session_table_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurants'
      AND column_name = 'active'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Migration 018 assertion failed: restaurants.active is not non-null boolean';
  END IF;

  IF to_regclass('public.restaurant_tables') IS NULL THEN
    RAISE EXCEPTION
      'Migration 018 assertion failed: public.restaurant_tables was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.restaurant_tables'::regclass
      AND con.conname =
        'uq_restaurant_tables_restaurant_table'
      AND con.contype = 'u'
  ) THEN
    RAISE EXCEPTION
      'Migration 018 assertion failed: restaurant/table uniqueness is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.table_sessions'::regclass
      AND con.conname =
        'fk_table_sessions_restaurant_table'
      AND con.contype = 'f'
  ) THEN
    RAISE EXCEPTION
      'Migration 018 assertion failed: table_sessions registry foreign key is missing';
  END IF;

  SELECT COUNT(*)
  INTO missing_session_table_count
  FROM public.table_sessions ts
  LEFT JOIN public.restaurant_tables rt
    ON rt.restaurant_id = ts.restaurant_id
   AND rt.table_id = ts.table_id
  WHERE rt.id IS NULL;

  IF missing_session_table_count > 0 THEN
    RAISE EXCEPTION
      'Migration 018 assertion failed: % table_session row(s) are missing registry ownership',
      missing_session_table_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid =
      'public.restaurant_tables'::regclass
      AND tgname =
        'trg_restaurant_tables_updated_at'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Migration 018 assertion failed: restaurant_tables updated_at trigger is missing';
  END IF;
END;
$$;

COMMIT;
