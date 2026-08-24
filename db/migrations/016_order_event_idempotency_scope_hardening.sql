BEGIN;

-- ============================================================================
-- Phase 40K — Order-event idempotency scope hardening
--
-- Migration 013 introduced the normalized order_events.idempotency_key column
-- and a uniqueness rule that included order_id. Including order_id allowed the
-- same idempotency key to create multiple orders. This migration replaces that
-- rule with restaurant-, event-, and actor-scoped uniqueness.
-- ============================================================================

SELECT pg_advisory_xact_lock(
  hashtextextended(
    '016_order_event_idempotency_scope_hardening',
    0
  )
);

DO $$
DECLARE
  duplicate_idempotency_count bigint;
BEGIN
  IF to_regclass('public.order_events') IS NULL THEN
    RAISE EXCEPTION
      'Phase 40K migration prerequisite failed: public.order_events is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_events'
      AND column_name = 'idempotency_key'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION
      'Phase 40K migration prerequisite failed: order_events.idempotency_key is missing';
  END IF;

  SELECT COUNT(*)
  INTO duplicate_idempotency_count
  FROM (
    SELECT
      restaurant_id,
      event_type,
      idempotency_key,
      CASE
        WHEN actor_user_id IS NOT NULL
          THEN 'user:' || actor_user_id::text
        WHEN actor_firebase_uid IS NOT NULL
          THEN 'firebase:' || actor_firebase_uid
        ELSE 'system'
      END AS actor_scope
    FROM public.order_events
    WHERE idempotency_key IS NOT NULL
    GROUP BY
      restaurant_id,
      event_type,
      idempotency_key,
      CASE
        WHEN actor_user_id IS NOT NULL
          THEN 'user:' || actor_user_id::text
        WHEN actor_firebase_uid IS NOT NULL
          THEN 'firebase:' || actor_firebase_uid
        ELSE 'system'
      END
    HAVING COUNT(*) > 1
  ) duplicate_scopes;

  IF duplicate_idempotency_count > 0 THEN
    RAISE EXCEPTION
      'Phase 40K migration found % duplicate actor-scoped order_event idempotency scope(s)',
      duplicate_idempotency_count;
  END IF;
END;
$$;

ALTER TABLE public.order_events
  DROP CONSTRAINT IF EXISTS
    chk_order_events_idempotency_actor_present;

ALTER TABLE public.order_events
  ADD CONSTRAINT chk_order_events_idempotency_actor_present
    CHECK (
      idempotency_key IS NULL
      OR event_type <> 'ORDER_CREATED'
      OR actor_user_id IS NOT NULL
      OR actor_firebase_uid IS NOT NULL
    );

DROP INDEX IF EXISTS public.uq_order_events_idempotency;

CREATE UNIQUE INDEX uq_order_events_idempotency
  ON public.order_events (
    restaurant_id,
    event_type,
    idempotency_key,
    (
      CASE
        WHEN actor_user_id IS NOT NULL
          THEN 'user:' || actor_user_id::text
        WHEN actor_firebase_uid IS NOT NULL
          THEN 'firebase:' || actor_firebase_uid
        ELSE 'system'
      END
    )
  )
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.order_events'::regclass
      AND con.conname =
        'chk_order_events_idempotency_actor_present'
      AND pg_get_constraintdef(con.oid, true)
        ILIKE '%idempotency_key IS NULL%'
      AND pg_get_constraintdef(con.oid, true)
        ILIKE '%event_type <> ''ORDER_CREATED''%'
      AND pg_get_constraintdef(con.oid, true)
        ILIKE '%actor_user_id IS NOT NULL%'
      AND pg_get_constraintdef(con.oid, true)
        ILIKE '%actor_firebase_uid IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40K assertion failed: idempotency actor-presence constraint is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx
      ON idx.oid = i.indexrelid
    JOIN pg_namespace idx_ns
      ON idx_ns.oid = idx.relnamespace
    WHERE idx_ns.nspname = 'public'
      AND idx.relname = 'uq_order_events_idempotency'
      AND i.indrelid = 'public.order_events'::regclass
      AND i.indisunique
      AND i.indnkeyatts = 4
      AND i.indexprs IS NOT NULL
      AND lower(pg_get_expr(i.indpred, i.indrelid)) =
        '(idempotency_key is not null)'
      AND lower(pg_get_expr(i.indexprs, i.indrelid))
        LIKE '%actor_user_id%'
      AND lower(pg_get_expr(i.indexprs, i.indrelid))
        LIKE '%actor_firebase_uid%'
      AND lower(pg_get_expr(i.indexprs, i.indrelid))
        LIKE '%user:%'
      AND lower(pg_get_expr(i.indexprs, i.indrelid))
        LIKE '%firebase:%'
      AND lower(pg_get_expr(i.indexprs, i.indrelid))
        LIKE '%system%'
  ) THEN
    RAISE EXCEPTION
      'Phase 40K assertion failed: actor-scoped idempotency index is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_events
    WHERE idempotency_key IS NOT NULL
      AND event_type = 'ORDER_CREATED'
      AND actor_user_id IS NULL
      AND actor_firebase_uid IS NULL
  ) THEN
    RAISE EXCEPTION
      'Phase 40K assertion failed: actorless idempotent ORDER_CREATED rows remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        restaurant_id,
        event_type,
        idempotency_key,
        CASE
          WHEN actor_user_id IS NOT NULL
            THEN 'user:' || actor_user_id::text
          WHEN actor_firebase_uid IS NOT NULL
            THEN 'firebase:' || actor_firebase_uid
          ELSE 'system'
        END AS actor_scope
      FROM public.order_events
      WHERE idempotency_key IS NOT NULL
      GROUP BY
        restaurant_id,
        event_type,
        idempotency_key,
        CASE
          WHEN actor_user_id IS NOT NULL
            THEN 'user:' || actor_user_id::text
          WHEN actor_firebase_uid IS NOT NULL
            THEN 'firebase:' || actor_firebase_uid
          ELSE 'system'
        END
      HAVING COUNT(*) > 1
    ) duplicate_scopes
  ) THEN
    RAISE EXCEPTION
      'Phase 40K assertion failed: duplicate actor-scoped idempotency rows remain';
  END IF;
END;
$$;

COMMIT;
