BEGIN;

-- ============================================================================
-- Phase 40K — Secure table-session tokens
--
-- Stores only SHA-256 token hashes. Raw QR/session tokens must never be stored,
-- logged, or returned after issuance.
-- ============================================================================

SELECT pg_advisory_xact_lock(
  hashtextextended('017_table_sessions', 0)
);

DO $$
BEGIN
  IF to_regclass('public.restaurants') IS NULL THEN
    RAISE EXCEPTION
      'Migration 017 prerequisite failed: public.restaurants is missing';
  END IF;

  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION
      'Migration 017 prerequisite failed: public.users is missing';
  END IF;
END;
$$;

CREATE TABLE public.table_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  table_id text NOT NULL,
  token_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_table_sessions_restaurant
    FOREIGN KEY (restaurant_id)
    REFERENCES public.restaurants(id)
    ON DELETE CASCADE,

  CONSTRAINT fk_table_sessions_created_by_user
    FOREIGN KEY (created_by_user_id)
    REFERENCES public.users(id)
    ON DELETE SET NULL,

  CONSTRAINT chk_table_sessions_table_id
    CHECK (
      table_id = btrim(table_id)
      AND table_id ~ '^[A-Za-z0-9_-]{1,64}$'
    ),

  CONSTRAINT chk_table_sessions_token_hash
    CHECK (octet_length(token_hash) = 32),

  CONSTRAINT chk_table_sessions_status
    CHECK (status IN ('ACTIVE', 'REVOKED')),

  CONSTRAINT chk_table_sessions_revocation_state
    CHECK (
      (status = 'ACTIVE' AND revoked_at IS NULL)
      OR
      (status = 'REVOKED' AND revoked_at IS NOT NULL)
    ),

  CONSTRAINT chk_table_sessions_expiration
    CHECK (
      expires_at IS NULL
      OR expires_at > created_at
    ),

  CONSTRAINT chk_table_sessions_updated_at
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_table_sessions_token_hash
  ON public.table_sessions (token_hash);

CREATE UNIQUE INDEX uq_table_sessions_active_table
  ON public.table_sessions (restaurant_id, table_id)
  WHERE status = 'ACTIVE'
    AND revoked_at IS NULL;

CREATE INDEX ix_table_sessions_verification
  ON public.table_sessions (
    token_hash,
    status,
    expires_at
  )
  WHERE status = 'ACTIVE'
    AND revoked_at IS NULL;

CREATE INDEX ix_table_sessions_restaurant
  ON public.table_sessions (
    restaurant_id,
    table_id,
    created_at DESC
  );

CREATE OR REPLACE FUNCTION
  public.set_table_sessions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_table_sessions_updated_at
BEFORE UPDATE ON public.table_sessions
FOR EACH ROW
EXECUTE FUNCTION public.set_table_sessions_updated_at();

COMMENT ON TABLE public.table_sessions IS
  'Revocable opaque QR table-session tokens. Only SHA-256 token hashes are stored.';

COMMENT ON COLUMN public.table_sessions.token_hash IS
  'SHA-256 digest of the raw opaque table-session token. Raw tokens must never be stored.';

COMMENT ON COLUMN public.table_sessions.table_id IS
  'Authoritative restaurant-scoped table identifier resolved by the verification route.';

DO $$
BEGIN
  IF to_regclass('public.table_sessions') IS NULL THEN
    RAISE EXCEPTION
      'Migration 017 assertion failed: public.table_sessions was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'table_sessions'
      AND column_name = 'token_hash'
      AND data_type = 'bytea'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'Migration 017 assertion failed: token_hash is not non-null bytea';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx
      ON idx.oid = i.indexrelid
    JOIN pg_namespace ns
      ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public'
      AND idx.relname = 'uq_table_sessions_token_hash'
      AND i.indrelid =
        'public.table_sessions'::regclass
      AND i.indisunique
  ) THEN
    RAISE EXCEPTION
      'Migration 017 assertion failed: token hash uniqueness is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx
      ON idx.oid = i.indexrelid
    JOIN pg_namespace ns
      ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public'
      AND idx.relname =
        'uq_table_sessions_active_table'
      AND i.indrelid =
        'public.table_sessions'::regclass
      AND i.indisunique
      AND lower(
        pg_get_expr(i.indpred, i.indrelid)
      ) LIKE '%status%active%'
      AND lower(
        pg_get_expr(i.indpred, i.indrelid)
      ) LIKE '%revoked_at is null%'
  ) THEN
    RAISE EXCEPTION
      'Migration 017 assertion failed: one-active-token-per-table invariant is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid =
      'public.table_sessions'::regclass
      AND tgname =
        'trg_table_sessions_updated_at'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Migration 017 assertion failed: updated_at trigger is missing';
  END IF;
END;
$$;

COMMIT;
