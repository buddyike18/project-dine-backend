BEGIN;

-- ------------------------------------------------------------------
-- Phase 7.4 — Create order_event_type enum (prerequisite for events)
-- ------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'order_event_type'
  ) THEN
    CREATE TYPE order_event_type AS ENUM (
      'STATUS_CHANGE',
      'RECALL',
      'ORDER_VOIDED',
      'ORDER_COMPED',
      'STATUS_OVERRIDDEN'
    );
  END IF;
END $$;

COMMIT;