BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('project-dine-backend:migration:021_schema_index_consolidation')
);

DO $$
BEGIN
  IF to_regclass('public.users_firebase_uid_key') IS NULL THEN
    RAISE EXCEPTION
      'Migration 021 prerequisite failed: users_firebase_uid_key is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.users'::regclass
      AND con.conname = 'users_firebase_uid_key'
      AND con.contype = 'u'
  ) THEN
    RAISE EXCEPTION
      'Migration 021 prerequisite failed: users_firebase_uid_key is not constraint-backed';
  END IF;

  IF to_regclass('public.users_restaurant_id_idx') IS NULL THEN
    RAISE EXCEPTION
      'Migration 021 prerequisite failed: users_restaurant_id_idx is missing';
  END IF;

  IF to_regclass('public.ux_payments_stripe_payment_intent_id') IS NULL THEN
    RAISE EXCEPTION
      'Migration 021 prerequisite failed: ux_payments_stripe_payment_intent_id is missing';
  END IF;
END;
$$;

DROP INDEX IF EXISTS public.users_firebase_uid_uidx;
DROP INDEX IF EXISTS public.idx_users_restaurant_id;
DROP INDEX IF EXISTS public.ux_payments_stripe_pi;

DO $$
BEGIN
  IF to_regclass('public.users_firebase_uid_uidx') IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 021 assertion failed: users_firebase_uid_uidx still exists';
  END IF;

  IF to_regclass('public.idx_users_restaurant_id') IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 021 assertion failed: idx_users_restaurant_id still exists';
  END IF;

  IF to_regclass('public.ux_payments_stripe_pi') IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 021 assertion failed: ux_payments_stripe_pi still exists';
  END IF;

  IF to_regclass('public.users_firebase_uid_key') IS NULL THEN
    RAISE EXCEPTION
      'Migration 021 assertion failed: users_firebase_uid_key is missing';
  END IF;

  IF to_regclass('public.users_restaurant_id_idx') IS NULL THEN
    RAISE EXCEPTION
      'Migration 021 assertion failed: users_restaurant_id_idx is missing';
  END IF;

  IF to_regclass('public.ux_payments_stripe_payment_intent_id') IS NULL THEN
    RAISE EXCEPTION
      'Migration 021 assertion failed: ux_payments_stripe_payment_intent_id is missing';
  END IF;
END;
$$;

COMMIT;
