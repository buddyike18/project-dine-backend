BEGIN;

-- ============================================================================
-- Phase 40K — Dual table-session verification rate limits
--
-- Separates broad client-network limits from tighter presented-token limits.
-- Only SHA-256 digests are stored.
-- ============================================================================

SELECT pg_advisory_xact_lock(
  hashtextextended(
    '020_table_session_dual_rate_limits',
    0
  )
);

DO $$
BEGIN
  IF to_regclass(
    'public.table_session_verification_limits'
  ) IS NULL THEN
    RAISE EXCEPTION
      'Migration 020 prerequisite failed: verification-limit table is missing';
  END IF;
END;
$$;

ALTER TABLE
  public.table_session_verification_limits
ADD COLUMN limit_type text;

UPDATE public.table_session_verification_limits
SET limit_type = 'network'
WHERE limit_type IS NULL;

ALTER TABLE
  public.table_session_verification_limits
ALTER COLUMN limit_type SET NOT NULL;

ALTER TABLE
  public.table_session_verification_limits
ADD CONSTRAINT
  chk_table_session_verification_limit_type
CHECK (
  limit_type IN ('network', 'token')
);

ALTER TABLE
  public.table_session_verification_limits
DROP CONSTRAINT
  table_session_verification_limits_pkey;

ALTER TABLE
  public.table_session_verification_limits
ADD CONSTRAINT
  table_session_verification_limits_pkey
PRIMARY KEY (
  limit_type,
  client_key
);

DO $$
DECLARE
  primary_key_definition text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name =
        'table_session_verification_limits'
      AND column_name = 'limit_type'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Migration 020 assertion failed: limit_type is not non-null text';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid =
      'public.table_session_verification_limits'::regclass
      AND con.conname =
        'chk_table_session_verification_limit_type'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid, true)
        ILIKE '%limit_type%'
      AND pg_get_constraintdef(con.oid, true)
        ILIKE '%network%'
      AND pg_get_constraintdef(con.oid, true)
        ILIKE '%token%'
  ) THEN
    RAISE EXCEPTION
      'Migration 020 assertion failed: limit-type check is missing';
  END IF;

  SELECT pg_get_constraintdef(con.oid, true)
  INTO primary_key_definition
  FROM pg_constraint con
  WHERE con.conrelid =
    'public.table_session_verification_limits'::regclass
    AND con.conname =
      'table_session_verification_limits_pkey'
    AND con.contype = 'p';

  IF primary_key_definition IS NULL
     OR lower(primary_key_definition) <>
       'primary key (limit_type, client_key)'
  THEN
    RAISE EXCEPTION
      'Migration 020 assertion failed: composite primary key is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.table_session_verification_limits
    WHERE limit_type NOT IN ('network', 'token')
  ) THEN
    RAISE EXCEPTION
      'Migration 020 assertion failed: invalid limit types remain';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class idx
    JOIN pg_namespace ns
      ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public'
      AND idx.relname =
        'ix_table_session_verification_limits_updated'
  ) THEN
    RAISE EXCEPTION
      'Migration 020 assertion failed: cleanup index is missing';
  END IF;
END;
$$;

COMMIT;
