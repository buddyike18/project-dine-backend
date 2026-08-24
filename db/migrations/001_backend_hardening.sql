BEGIN;

-- 001_backend_hardening.sql
-- Enforce core invariants from BACKEND_CONTRACT.md at the database level:
-- 1) Paid-before-SENT
-- 2) Legal order_status transitions (including explicit recall SENT -> OPEN and READY -> OPEN)

-- Minimal fields to track recall events on the order record itself.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS recalled_at timestamptz,
  ADD COLUMN IF NOT EXISTS recall_reason text;

-- Invariant: Orders cannot be SENT unless fully paid.
CREATE OR REPLACE FUNCTION dine_enforce_paid_before_sent()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'SENT' AND COALESCE(NEW.paid_cents, 0) < COALESCE(NEW.total_cents, 0) THEN
    RAISE EXCEPTION 'Order cannot be SENT unless fully paid (paid_cents %, total_cents %)', NEW.paid_cents, NEW.total_cents
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dine_enforce_paid_before_sent ON orders;

CREATE TRIGGER trg_dine_enforce_paid_before_sent
BEFORE INSERT OR UPDATE OF status, paid_cents, total_cents ON orders
FOR EACH ROW
EXECUTE FUNCTION dine_enforce_paid_before_sent();

-- Invariant: Only allow the contract-defined order_status transitions.
-- Allowed transitions:
-- OPEN -> SENT (only if paid-before-SENT invariant holds)
-- SENT -> READY
-- SENT -> OPEN (RECALL)
-- READY -> OPEN (RECALL)
-- READY -> SENT (KDS RECALL)
-- READY -> CLOSED
-- ANY -> CANCELLED
CREATE OR REPLACE FUNCTION dine_enforce_order_status_transitions()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- Always allow cancellation (manager-only is enforced at the API layer; DB enforces audit + consistency)
    IF NEW.status = 'CANCELLED' THEN
      RETURN NEW;
    END IF;

    -- OPEN -> SENT (payment reconciliation)
    IF OLD.status = 'OPEN' AND NEW.status = 'SENT' THEN
      RETURN NEW;
    END IF;

    -- SENT -> READY
    IF OLD.status = 'SENT' AND NEW.status = 'READY' THEN
      RETURN NEW;
    END IF;

    -- READY -> CLOSED
    IF OLD.status = 'READY' AND NEW.status = 'CLOSED' THEN
      RETURN NEW;
    END IF;

    -- SENT -> OPEN (RECALL)
    IF OLD.status = 'SENT' AND NEW.status = 'OPEN' THEN
      NEW.recalled_at := COALESCE(NEW.recalled_at, now());
      RETURN NEW;
    END IF;

    -- READY -> OPEN (RECALL)
    IF OLD.status = 'READY' AND NEW.status = 'OPEN' THEN
      NEW.recalled_at := COALESCE(NEW.recalled_at, now());
      NEW.ready_at := NULL;
      RETURN NEW;
    END IF;

    -- READY -> SENT (KDS RECALL)
    IF OLD.status = 'READY' AND NEW.status = 'SENT' THEN
      NEW.recalled_at := now();
      NEW.ready_at := NULL;
      RETURN NEW;
    END IF;

    -- Any other transition is illegal
    RAISE EXCEPTION 'Illegal order status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dine_enforce_order_status_transitions ON orders;

CREATE TRIGGER trg_dine_enforce_order_status_transitions
BEFORE UPDATE OF status ON orders
FOR EACH ROW
EXECUTE FUNCTION dine_enforce_order_status_transitions();

COMMIT;