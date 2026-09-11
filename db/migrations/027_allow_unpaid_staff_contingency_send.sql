BEGIN;

CREATE OR REPLACE FUNCTION dine_enforce_order_send_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_type TEXT := UPPER(COALESCE(NEW.type::text, ''));
  is_staff_table_order BOOLEAN;
  is_staff_bar_order BOOLEAN;
  is_staff_quick_order BOOLEAN;
  is_staff_contingency_order BOOLEAN;
BEGIN
  is_staff_table_order :=
    NEW.order_origin = 'STAFF'
    AND NEW.table_id IS NOT NULL
    AND NEW.check_id IS NULL
    AND order_type <> 'QUICK';

  is_staff_bar_order :=
    NEW.order_origin = 'STAFF'
    AND NEW.check_id IS NOT NULL
    AND NEW.table_id IS NULL;

  is_staff_quick_order :=
    NEW.order_origin = 'STAFF'
    AND order_type = 'QUICK'
    AND NEW.table_id IS NULL
    AND NEW.check_id IS NULL;

  is_staff_contingency_order :=
    is_staff_table_order
    OR is_staff_bar_order
    OR is_staff_quick_order;

  IF NEW.status IN ('SENT', 'READY', 'CLOSED')
     AND COALESCE(NEW.paid_cents, 0) + COALESCE(NEW.comped_cents, 0)
         < COALESCE(NEW.total_cents, 0)
     AND NOT is_staff_contingency_order
  THEN
    RAISE EXCEPTION
      'Order cannot remain beyond OPEN unless financially settled'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
