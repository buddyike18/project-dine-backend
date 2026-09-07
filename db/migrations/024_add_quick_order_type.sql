BEGIN;

-- ------------------------------------------------------------------
-- Phase 41 — Quick Order Type
-- ------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumlabel = 'QUICK'
      AND enumtypid = 'order_type'::regtype
  ) THEN
    ALTER TYPE order_type ADD VALUE 'QUICK';
  END IF;
END $$;

COMMIT;
