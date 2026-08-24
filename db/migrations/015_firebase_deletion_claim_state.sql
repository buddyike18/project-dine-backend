BEGIN;

-- Phase 40I
-- Migration 015
-- Add an explicit IN_PROGRESS state so Firebase deletion work can be
-- claimed atomically before the external Firebase request begins.
--
-- This migration adds claim metadata columns and updates constraints.
-- It validates existing state but does not repair or modify user rows.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS firebase_deletion_claimed_at TIMESTAMPTZ;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS firebase_deletion_claim_token UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.users
    WHERE firebase_deletion_status IS NULL
  ) THEN
    RAISE EXCEPTION
      'Migration 015 prerequisite failed: firebase_deletion_status contains NULL values';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.users
    WHERE NOT (
      (
        firebase_deletion_status = 'NONE'
        AND firebase_deletion_requested_at IS NULL
        AND firebase_deletion_completed_at IS NULL
        AND firebase_deletion_last_error IS NULL
      )
      OR
      (
        firebase_deletion_status = 'PENDING'
        AND firebase_deletion_requested_at IS NOT NULL
        AND firebase_deletion_completed_at IS NULL
        AND firebase_deletion_last_error IS NULL
      )
      OR
      (
        firebase_deletion_status = 'FAILED'
        AND firebase_deletion_requested_at IS NOT NULL
        AND firebase_deletion_completed_at IS NULL
        AND firebase_deletion_last_error IS NOT NULL
      )
      OR
      (
        firebase_deletion_status = 'COMPLETED'
        AND firebase_deletion_requested_at IS NOT NULL
        AND firebase_deletion_completed_at IS NOT NULL
        AND firebase_deletion_last_error IS NULL
      )
    )
  ) THEN
    RAISE EXCEPTION
      'Migration 015 prerequisite failed: existing Firebase deletion state is invalid';
  END IF;
END
$$;

ALTER TABLE public.users
  ALTER COLUMN firebase_deletion_status SET NOT NULL;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_firebase_deletion_state_check;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_firebase_deletion_status_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_firebase_deletion_status_check
  CHECK (
    firebase_deletion_status IN (
      'NONE',
      'PENDING',
      'IN_PROGRESS',
      'COMPLETED',
      'FAILED'
    )
  );

ALTER TABLE public.users
  ADD CONSTRAINT users_firebase_deletion_state_check
  CHECK (
    (
      firebase_deletion_status = 'NONE'
      AND firebase_deletion_requested_at IS NULL
      AND firebase_deletion_completed_at IS NULL
      AND firebase_deletion_last_error IS NULL
      AND firebase_deletion_claimed_at IS NULL
      AND firebase_deletion_claim_token IS NULL
    )
    OR
    (
      firebase_deletion_status = 'PENDING'
      AND firebase_deletion_requested_at IS NOT NULL
      AND firebase_deletion_completed_at IS NULL
      AND firebase_deletion_last_error IS NULL
      AND firebase_deletion_claimed_at IS NULL
      AND firebase_deletion_claim_token IS NULL
    )
    OR
    (
      firebase_deletion_status = 'IN_PROGRESS'
      AND firebase_deletion_requested_at IS NOT NULL
      AND firebase_deletion_completed_at IS NULL
      AND firebase_deletion_last_error IS NULL
      AND firebase_deletion_claimed_at IS NOT NULL
      AND firebase_deletion_claim_token IS NOT NULL
    )
    OR
    (
      firebase_deletion_status = 'FAILED'
      AND firebase_deletion_requested_at IS NOT NULL
      AND firebase_deletion_completed_at IS NULL
      AND firebase_deletion_last_error IS NOT NULL
      AND firebase_deletion_claimed_at IS NULL
      AND firebase_deletion_claim_token IS NULL
    )
    OR
    (
      firebase_deletion_status = 'COMPLETED'
      AND firebase_deletion_requested_at IS NOT NULL
      AND firebase_deletion_completed_at IS NOT NULL
      AND firebase_deletion_last_error IS NULL
      AND firebase_deletion_claimed_at IS NULL
      AND firebase_deletion_claim_token IS NULL
    )
  );

COMMIT;
