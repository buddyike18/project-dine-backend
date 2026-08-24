BEGIN;

-- ============================================================================
-- Phase 40K — Shared table-session verification rate limits
-- ============================================================================

SELECT pg_advisory_xact_lock(
  hashtextextended(
    '019_table_session_verification_rate_limits',
    0
  )
);

CREATE TABLE public.table_session_verification_limits (
  client_key bytea PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_table_session_verification_client_key
    CHECK (octet_length(client_key) = 32),

  CONSTRAINT chk_table_session_verification_attempt_count
    CHECK (attempt_count >= 1)
);

CREATE INDEX ix_table_session_verification_limits_updated
  ON public.table_session_verification_limits (
    updated_at
  );

COMMENT ON TABLE public.table_session_verification_limits IS
  'Shared PostgreSQL-backed rate limits for public table-session verification. Client identifiers are stored only as SHA-256 hashes.';

COMMENT ON COLUMN
  public.table_session_verification_limits.client_key IS
  'SHA-256 digest of the normalized request client identifier. Raw IP addresses are not stored.';

DO $$
BEGIN
  IF to_regclass(
    'public.table_session_verification_limits'
  ) IS NULL THEN
    RAISE EXCEPTION
      'Migration 019 assertion failed: verification-limit table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name =
        'table_session_verification_limits'
      AND column_name = 'client_key'
      AND data_type = 'bytea'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Migration 019 assertion failed: client_key is not non-null bytea';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid =
      'public.table_session_verification_limits'::regclass
      AND con.contype = 'p'
  ) THEN
    RAISE EXCEPTION
      'Migration 019 assertion failed: primary key is missing';
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
      'Migration 019 assertion failed: cleanup index is missing';
  END IF;
END;
$$;

COMMIT;
