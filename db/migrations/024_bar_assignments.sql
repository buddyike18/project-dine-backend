BEGIN;

CREATE TABLE IF NOT EXISTS public.bar_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL
    REFERENCES public.restaurants(id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, staff_user_id)
);

CREATE INDEX IF NOT EXISTS idx_bar_assignments_restaurant
  ON public.bar_assignments (restaurant_id);

CREATE INDEX IF NOT EXISTS idx_bar_assignments_staff
  ON public.bar_assignments (staff_user_id);

COMMIT;
