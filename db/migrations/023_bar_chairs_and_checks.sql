BEGIN;

-- ============================================================
-- 023 — Bar chairs + open checks
--
-- Structural foundation only.
--
-- This migration intentionally does NOT:
--   - alter payment behavior
--   - alter KDS queries
--   - alter order send eligibility
--   - alter customer/table-session behavior
-- ============================================================

DO $$
BEGIN
  CREATE TYPE public.check_status AS ENUM (
    'OPEN',
    'CLOSED',
    'VOIDED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

-- ============================================================
-- BAR CHAIRS
-- Persistent bartender-facing bar positions.
-- These are intentionally separate from restaurant_tables and
-- table_sessions.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bar_chairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL
    REFERENCES public.restaurants(id)
    ON DELETE CASCADE,

  chair_number integer NOT NULL,

  display_name text,

  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_bar_chairs_restaurant_chair_number
    UNIQUE (restaurant_id, chair_number),

  CONSTRAINT uq_bar_chairs_restaurant_id_id
    UNIQUE (restaurant_id, id),

  CONSTRAINT chk_bar_chairs_chair_number
    CHECK (chair_number > 0),

  CONSTRAINT chk_bar_chairs_display_name
    CHECK (
      display_name IS NULL
      OR (
        display_name = btrim(display_name)
        AND char_length(display_name) BETWEEN 1 AND 120
      )
    ),

  CONSTRAINT chk_bar_chairs_updated_at
    CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS ix_bar_chairs_restaurant_active
  ON public.bar_chairs (
    restaurant_id,
    active,
    chair_number
  );

CREATE OR REPLACE FUNCTION public.set_bar_chairs_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  trg_bar_chairs_updated_at
  ON public.bar_chairs;

CREATE TRIGGER trg_bar_chairs_updated_at
BEFORE UPDATE ON public.bar_chairs
FOR EACH ROW
EXECUTE FUNCTION public.set_bar_chairs_updated_at();

COMMENT ON TABLE public.bar_chairs IS
  'Restaurant-scoped persistent bar chair registry used by staff POS workflows.';

COMMENT ON COLUMN public.bar_chairs.chair_number IS
  'Human-facing positive bar chair number unique within a restaurant.';

COMMENT ON COLUMN public.bar_chairs.active IS
  'Whether the chair is available for new POS bar checks.';

-- ============================================================
-- CHECKS
--
-- A check is the financial/operational parent for one or more
-- staff-created order rounds.
--
-- POS may present these to users as "Tabs".
-- ============================================================

CREATE TABLE IF NOT EXISTS public.checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL
    REFERENCES public.restaurants(id)
    ON DELETE CASCADE,

  bar_chair_id uuid,

  opened_by_user_id uuid NOT NULL
    REFERENCES public.users(id)
    ON DELETE RESTRICT,

  closed_by_user_id uuid
    REFERENCES public.users(id)
    ON DELETE RESTRICT,

  display_name text,

  status public.check_status NOT NULL DEFAULT 'OPEN',

  opened_at timestamptz NOT NULL DEFAULT now(),

  closed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_checks_restaurant_id_id
    UNIQUE (restaurant_id, id),

  CONSTRAINT fk_checks_restaurant_bar_chair
    FOREIGN KEY (restaurant_id, bar_chair_id)
    REFERENCES public.bar_chairs (
      restaurant_id,
      id
    )
    ON UPDATE CASCADE
    ON DELETE RESTRICT,

  CONSTRAINT chk_checks_display_name
    CHECK (
      display_name IS NULL
      OR (
        display_name = btrim(display_name)
        AND char_length(display_name) BETWEEN 1 AND 120
      )
    ),

  CONSTRAINT chk_checks_status_timestamps
    CHECK (
      (
        status = 'OPEN'
        AND closed_at IS NULL
        AND closed_by_user_id IS NULL
      )
      OR
      (
        status IN ('CLOSED', 'VOIDED')
        AND closed_at IS NOT NULL
      )
    ),

  CONSTRAINT chk_checks_closed_after_opened
    CHECK (
      closed_at IS NULL
      OR closed_at >= opened_at
    ),

  CONSTRAINT chk_checks_updated_at
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_checks_one_open_per_bar_chair
  ON public.checks (
    restaurant_id,
    bar_chair_id
  )
  WHERE status = 'OPEN'
    AND bar_chair_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_checks_restaurant_status
  ON public.checks (
    restaurant_id,
    status,
    opened_at DESC
  );

CREATE INDEX IF NOT EXISTS ix_checks_opened_by
  ON public.checks (
    restaurant_id,
    opened_by_user_id,
    status
  );

CREATE OR REPLACE FUNCTION public.set_checks_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  trg_checks_updated_at
  ON public.checks;

CREATE TRIGGER trg_checks_updated_at
BEFORE UPDATE ON public.checks
FOR EACH ROW
EXECUTE FUNCTION public.set_checks_updated_at();

COMMENT ON TABLE public.checks IS
  'Restaurant-scoped staff POS check/tab that may contain multiple order rounds before final settlement.';

COMMENT ON COLUMN public.checks.bar_chair_id IS
  'Optional persistent bar chair associated with the currently open check.';

COMMENT ON COLUMN public.checks.display_name IS
  'Optional staff-facing tab/check label such as a guest name.';

-- ============================================================
-- ORDERS → CHECK
--
-- Null continues to mean an ordinary standalone Dine order.
-- Non-null identifies one round belonging to a staff-managed
-- check/tab.
--
-- Restaurant identity is enforced by the composite foreign key.
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS check_id uuid;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS fk_orders_restaurant_check;

ALTER TABLE public.orders
  ADD CONSTRAINT fk_orders_restaurant_check
    FOREIGN KEY (restaurant_id, check_id)
    REFERENCES public.checks (
      restaurant_id,
      id
    )
    ON UPDATE CASCADE
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_orders_check_id
  ON public.orders (check_id)
  WHERE check_id IS NOT NULL;

COMMENT ON COLUMN public.orders.check_id IS
  'Optional parent POS check/tab. Null indicates an ordinary standalone order.';

-- ============================================================
-- POST-MIGRATION ASSERTIONS
-- ============================================================

DO $$
DECLARE
  check_status_values text[];
BEGIN
  IF to_regclass('public.bar_chairs') IS NULL THEN
    RAISE EXCEPTION
      'Migration 023 assertion failed: public.bar_chairs is missing';
  END IF;

  IF to_regclass('public.checks') IS NULL THEN
    RAISE EXCEPTION
      'Migration 023 assertion failed: public.checks is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'check_id'
      AND data_type = 'uuid'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'Migration 023 assertion failed: orders.check_id is not nullable uuid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND conname = 'fk_orders_restaurant_check'
      AND contype = 'f'
  ) THEN
    RAISE EXCEPTION
      'Migration 023 assertion failed: orders/check foreign key is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.checks'::regclass
      AND conname = 'fk_checks_restaurant_bar_chair'
      AND contype = 'f'
  ) THEN
    RAISE EXCEPTION
      'Migration 023 assertion failed: check/bar-chair foreign key is missing';
  END IF;

  IF to_regclass('public.uq_checks_one_open_per_bar_chair') IS NULL THEN
    RAISE EXCEPTION
      'Migration 023 assertion failed: one-open-check-per-chair index is missing';
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO check_status_values
  FROM pg_type t
  JOIN pg_enum e
    ON e.enumtypid = t.oid
  JOIN pg_namespace n
    ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
    AND t.typname = 'check_status';

  IF check_status_values IS DISTINCT FROM
    ARRAY['OPEN', 'CLOSED', 'VOIDED']::text[]
  THEN
    RAISE EXCEPTION
      'Migration 023 assertion failed: check_status enum is invalid: %',
      check_status_values;
  END IF;
END;
$$;

COMMIT;
