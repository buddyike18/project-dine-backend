BEGIN;

-- 006_allow_ready_to_sent.sql
-- Update DB trigger to allow READY -> SENT (KDS recall)

CREATE OR REPLACE FUNCTION dine_enforce_order_status_transitions()
RETURNS trigger AS $$
BEGIN
  -- Allow same-state updates
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- OPEN -> SENT
  IF OLD.status = 'OPEN' AND NEW.status = 'SENT' THEN
    RETURN NEW;
  END IF;

  -- SENT -> READY
  IF OLD.status = 'SENT' AND NEW.status = 'READY' THEN
    NEW.ready_at := COALESCE(NEW.ready_at, now());
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

  -- READY -> CLOSED
  IF OLD.status = 'READY' AND NEW.status = 'CLOSED' THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
    RETURN NEW;
  END IF;

  -- ANY -> CANCELLED
  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  -- Illegal transition
  RAISE EXCEPTION 'Illegal order status transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

COMMIT;
