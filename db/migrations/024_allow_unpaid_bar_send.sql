BEGIN;

CREATE OR REPLACE FUNCTION dine_enforce_order_send_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('SENT', 'READY', 'CLOSED')
     AND COALESCE(NEW.paid_cents, 0) + COALESCE(NEW.comped_cents, 0)
         < COALESCE(NEW.total_cents, 0)
     AND NOT (
       NEW.order_origin = 'STAFF'
       AND NEW.check_id IS NOT NULL
       AND NEW.table_id IS NULL
     )
  THEN
    RAISE EXCEPTION
      'Order cannot remain beyond OPEN unless financially settled'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
