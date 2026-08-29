BEGIN;

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS automatic_gratuity_enabled
    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automatic_gratuity_bps
    integer NOT NULL DEFAULT 0;

ALTER TABLE public.restaurants
  DROP CONSTRAINT IF EXISTS chk_restaurants_automatic_gratuity_bps;

ALTER TABLE public.restaurants
  ADD CONSTRAINT chk_restaurants_automatic_gratuity_bps
  CHECK (
    automatic_gratuity_bps BETWEEN 0 AND 5000
  );

COMMENT ON COLUMN public.restaurants.automatic_gratuity_enabled IS
  'Whether this restaurant automatically applies gratuity to customer orders.';

COMMENT ON COLUMN public.restaurants.automatic_gratuity_bps IS
  'Restaurant-configured automatic gratuity percentage in basis points; 1800 = 18%.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurants'
      AND column_name = 'automatic_gratuity_enabled'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Migration 022 assertion failed: automatic_gratuity_enabled is not non-null boolean';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurants'
      AND column_name = 'automatic_gratuity_bps'
      AND data_type = 'integer'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Migration 022 assertion failed: automatic_gratuity_bps is not non-null integer';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.restaurants'::regclass
      AND conname = 'chk_restaurants_automatic_gratuity_bps'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      'Migration 022 assertion failed: automatic gratuity basis-point constraint is missing';
  END IF;
END;
$$;

COMMIT;
