-- 004_user_identity_hardening.sql
-- Phase 7.1 prerequisite: stable mapping between Firebase auth and Postgres users
--
-- Goals:
-- 1) Ensure users.firebase_uid exists and is UNIQUE (required by auth UPSERT).
-- 2) Ensure users.restaurant_id exists for staff scoping.
-- 3) Backfill users.firebase_uid from legacy users.id when missing.
--
-- Safe to run multiple times.

BEGIN;

-- 1) Ensure columns exist
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS firebase_uid TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS restaurant_id UUID;

-- 2) Backfill firebase_uid for legacy rows.
-- Legacy behavior in earlier phases used Firebase UID as users.id.
-- We only backfill where firebase_uid is NULL.
UPDATE users
SET firebase_uid = users.id::text
WHERE firebase_uid IS NULL
  AND users.id IS NOT NULL;

-- 3) Ensure we can enforce uniqueness before creating the unique index.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT firebase_uid
    FROM users
    WHERE firebase_uid IS NOT NULL
    GROUP BY firebase_uid
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot add UNIQUE constraint on users.firebase_uid: duplicate firebase_uid values exist. Resolve duplicates, then re-run migration.';
  END IF;
END $$;

-- 4) Enforce uniqueness for firebase_uid.
-- Unique index allows multiple NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_uidx ON users(firebase_uid);

-- 5) Helpful index for restaurant scoping.
CREATE INDEX IF NOT EXISTS users_restaurant_id_idx ON users(restaurant_id);

-- 6) Optional FK: only add if restaurants table exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'restaurants'
  ) THEN
    -- Add FK only if not already present
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'users_restaurant_id_fkey'
    ) THEN
      ALTER TABLE users
        ADD CONSTRAINT users_restaurant_id_fkey
        FOREIGN KEY (restaurant_id)
        REFERENCES restaurants(id)
        ON DELETE RESTRICT;
    END IF;
  END IF;
END $$;

COMMIT;

-- Notes:
-- - This migration intentionally does NOT attempt to change users.id type.
--   If users.id is TEXT in legacy data, UUID strings still store safely and app code will work.
-- - If you want users.id to be a UUID type, do it in a dedicated, carefully staged migration
--   (because other tables may FK to users.id).
