BEGIN;

-- ============================================================
-- 026 — Check-scoped payments + payment/order allocations
--
-- Extends the existing order-scoped payment model so one
-- authoritative payment may settle multiple orders belonging
-- to a staff-managed check/tab.
--
-- This migration intentionally does NOT:
--   - alter Stripe webhook behavior
--   - alter payment initiation behavior
--   - alter bar routes
--   - alter POS behavior
--   - change order settlement behavior
-- ============================================================

-- ============================================================
-- PAYMENTS → ORDER OR CHECK
--
-- Existing customer payments remain order-scoped.
-- New check payments may instead be check-scoped.
--
-- Exactly one financial parent must be present.
-- ============================================================

ALTER TABLE public.payments
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS check_id uuid;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS chk_payments_exactly_one_scope;

ALTER TABLE public.payments
  ADD CONSTRAINT chk_payments_exactly_one_scope
    CHECK (
      (
        order_id IS NOT NULL
        AND check_id IS NULL
      )
      OR
      (
        order_id IS NULL
        AND check_id IS NOT NULL
      )
    );

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS fk_payments_restaurant_check;

ALTER TABLE public.payments
  ADD CONSTRAINT fk_payments_restaurant_check
    FOREIGN KEY (restaurant_id, check_id)
    REFERENCES public.checks (
      restaurant_id,
      id
    )
    ON UPDATE CASCADE
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_payments_check_id
  ON public.payments (check_id);

COMMENT ON COLUMN public.payments.order_id IS
  'Order scope for an order-anchored payment. Null when the payment is scoped to a staff-managed check/tab.';

COMMENT ON COLUMN public.payments.check_id IS
  'Check/tab scope for a check-anchored payment. Null when the payment is scoped to one order.';

-- ============================================================
-- PAYMENT → ORDER ALLOCATIONS
--
-- A check-scoped payment is one provider transaction that may
-- settle multiple constituent orders. Allocation rows preserve
-- the authoritative amount applied to each order.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payment_order_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  payment_id uuid NOT NULL,

  order_id uuid NOT NULL,

  amount_cents integer NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_payment_order_allocations_payment_order
    UNIQUE (payment_id, order_id),

  CONSTRAINT fk_payment_order_allocations_payment
    FOREIGN KEY (payment_id)
    REFERENCES public.payments(id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,

  CONSTRAINT fk_payment_order_allocations_order
    FOREIGN KEY (order_id)
    REFERENCES public.orders(id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,

  CONSTRAINT chk_payment_order_allocations_amount_positive
    CHECK (amount_cents > 0)
);

CREATE INDEX IF NOT EXISTS ix_payment_order_allocations_order_id
  ON public.payment_order_allocations (order_id);

COMMENT ON TABLE public.payment_order_allocations IS
  'Authoritative allocation of one payment across one or more Dine orders, primarily for staff-managed check/tab settlement.';

COMMENT ON COLUMN public.payment_order_allocations.payment_id IS
  'Authoritative payment transaction whose value is allocated to the referenced order.';

COMMENT ON COLUMN public.payment_order_allocations.order_id IS
  'Order receiving part of the authoritative payment transaction.';

COMMENT ON COLUMN public.payment_order_allocations.amount_cents IS
  'Positive amount of the payment allocated to this order, expressed in cents.';

COMMIT;
