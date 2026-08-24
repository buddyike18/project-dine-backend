

-- Phase 26 fix: remove invalid cancelled_at reference from status transition trigger

CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS trigger AS $$
BEGIN
  -- ANY -> CANCELLED (VOID)
  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  -- OPEN -> SENT
  IF OLD.status = 'OPEN' AND NEW.status = 'SENT' THEN
    RETURN NEW;
  END IF;

  -- SENT -> READY
  IF OLD.status = 'SENT' AND NEW.status = 'READY' THEN
    RETURN NEW;
  END IF;

  -- READY -> SENT (RECALL)
  IF OLD.status = 'READY' AND NEW.status = 'SENT' THEN
    RETURN NEW;
  END IF;

  -- block invalid transitions
  RAISE EXCEPTION 'Invalid status transition from % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger to ensure updated function is used
DROP TRIGGER IF EXISTS trg_enforce_order_status_transition ON orders;

CREATE TRIGGER trg_enforce_order_status_transition
BEFORE UPDATE OF status ON orders
FOR EACH ROW
EXECUTE FUNCTION enforce_order_status_transition();