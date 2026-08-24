

-- Phase 26 fix: remove invalid cancelled_at reference from dine_enforce_order_status_transitions

CREATE OR REPLACE FUNCTION dine_enforce_order_status_transitions()
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

  -- Phase 28 recall paths (manager-only at API layer)
  -- SENT -> OPEN (RECALL)
  IF OLD.status = 'SENT' AND NEW.status = 'OPEN' THEN
    RETURN NEW;
  END IF;

  -- READY -> OPEN (RECALL)
  IF OLD.status = 'READY' AND NEW.status = 'OPEN' THEN
    RETURN NEW;
  END IF;

  -- block invalid transitions
  RAISE EXCEPTION 'Invalid status transition from % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;