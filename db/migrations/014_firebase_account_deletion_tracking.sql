
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS firebase_deletion_status text,
  ADD COLUMN IF NOT EXISTS firebase_deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS firebase_deletion_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS firebase_deletion_last_error text;

UPDATE public.users
SET firebase_deletion_status = 'NONE'
WHERE firebase_deletion_status IS NULL;

ALTER TABLE public.users
  ALTER COLUMN firebase_deletion_status SET DEFAULT 'NONE',
  ALTER COLUMN firebase_deletion_status SET NOT NULL;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_firebase_deletion_status_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_firebase_deletion_status_check
  CHECK (
    firebase_deletion_status IN ('NONE', 'PENDING', 'COMPLETED', 'FAILED')
  );

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_firebase_deletion_state_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_firebase_deletion_state_check
  CHECK (
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
  );

CREATE INDEX IF NOT EXISTS idx_users_firebase_deletion_retry
  ON public.users (
    firebase_deletion_status,
    firebase_deletion_requested_at
  )
  WHERE firebase_deletion_status IN ('PENDING', 'FAILED');

