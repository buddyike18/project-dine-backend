BEGIN;

-- ------------------------------------------------------------------
-- Phase 41 — Explicit check classification
-- ------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'check_type'
  ) THEN
    CREATE TYPE check_type AS ENUM ('BAR', 'QUICK');
  END IF;
END $$;

ALTER TABLE checks
  ADD COLUMN IF NOT EXISTS check_type check_type;

UPDATE checks
SET check_type = 'BAR'
WHERE check_type IS NULL;

ALTER TABLE checks
  ALTER COLUMN check_type SET DEFAULT 'BAR',
  ALTER COLUMN check_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'checks_check_type_chair_context_chk'
  ) THEN
    ALTER TABLE checks
      ADD CONSTRAINT checks_check_type_chair_context_chk
      CHECK (
        (check_type = 'BAR' AND bar_chair_id IS NOT NULL)
        OR
        (check_type = 'QUICK' AND bar_chair_id IS NULL)
      );
  END IF;
END $$;

COMMIT;
