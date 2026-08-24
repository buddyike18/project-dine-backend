

BEGIN;

-- ------------------------------------------------------------------
-- Phase 7.4 — Order Origin + Event Type Hardening (KDS Readiness)
-- ------------------------------------------------------------------

-- 1) Create order_origin enum if it does not exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'order_origin'
  ) THEN
    CREATE TYPE order_origin AS ENUM ('STAFF', 'CUSTOMER');
  END IF;
END $$;

-- 2) Add order_origin column to orders (nullable initially for backfill)
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS order_origin order_origin;

-- 3) Backfill existing orders as STAFF (traditional POS default)
UPDATE orders
SET order_origin = 'STAFF'
WHERE order_origin IS NULL;

-- 4) Enforce NOT NULL after backfill
ALTER TABLE orders
ALTER COLUMN order_origin SET NOT NULL;

-- 5) Extend order_event_type enum for Phase 7.2 / 7.3
DO $$
BEGIN
  -- Core lifecycle events
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'STATUS_CHANGE' AND enumtypid = 'order_event_type'::regtype) THEN
    ALTER TYPE order_event_type ADD VALUE 'STATUS_CHANGE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'RECALL' AND enumtypid = 'order_event_type'::regtype) THEN
    ALTER TYPE order_event_type ADD VALUE 'RECALL';
  END IF;

  -- Manager / override events
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ORDER_VOIDED' AND enumtypid = 'order_event_type'::regtype) THEN
    ALTER TYPE order_event_type ADD VALUE 'ORDER_VOIDED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ORDER_COMPED' AND enumtypid = 'order_event_type'::regtype) THEN
    ALTER TYPE order_event_type ADD VALUE 'ORDER_COMPED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'STATUS_OVERRIDDEN' AND enumtypid = 'order_event_type'::regtype) THEN
    ALTER TYPE order_event_type ADD VALUE 'STATUS_OVERRIDDEN';
  END IF;
END $$;

COMMIT;