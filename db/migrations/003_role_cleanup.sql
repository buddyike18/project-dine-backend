BEGIN;

-- 003_role_cleanup.sql
-- Remove obsolete Owner role and enforce Manager / Employee / Customer only.

-- 1) Update any existing rows that still reference Owner (case-insensitive)
--    Map them to Manager (highest remaining authority).
--    Use text casts so this works even if the current enum does not include Owner.
UPDATE users
SET role = 'Manager'
WHERE lower(role::text) = 'owner';

-- Normalize legacy lowercase values into Title Case expected by the new enum.
UPDATE users
SET role = 'Manager'
WHERE lower(role::text) = 'manager';

UPDATE users
SET role = 'Employee'
WHERE lower(role::text) IN ('employee','staff');

UPDATE users
SET role = 'Customer'
WHERE lower(role::text) = 'customer';

-- Drop the existing default so the role column can be re-typed safely
ALTER TABLE users
  ALTER COLUMN role DROP DEFAULT;

-- 2) Recreate the role_type enum without 'Owner' ONLY if needed.
-- If role_type already matches desired values, this becomes a no-op.
DO $$
DECLARE
  has_owner boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'role_type'
      AND e.enumlabel = 'Owner'
  ) INTO has_owner;

  IF has_owner THEN
    -- Create a new enum without Owner
    CREATE TYPE role_type_new AS ENUM ('Manager', 'Employee', 'Customer');

    -- Retype users.role
    ALTER TABLE users
      ALTER COLUMN role TYPE role_type_new
      USING role::text::role_type_new;

    -- Retype order_events.actor_role if it exists (keep backwards compatibility)
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'order_events'
        AND column_name = 'actor_role'
    ) THEN
      ALTER TABLE public.order_events
        ALTER COLUMN actor_role TYPE role_type_new
        USING actor_role::text::role_type_new;
    END IF;

    -- Drop old enum and rename new enum
    DROP TYPE role_type;
    ALTER TYPE role_type_new RENAME TO role_type;
  END IF;
END $$;

-- Restore a valid default for the role column
ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'Employee';

COMMIT;