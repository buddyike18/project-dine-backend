

CREATE TABLE IF NOT EXISTS public.table_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  staff_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, table_id)
);

CREATE INDEX IF NOT EXISTS idx_table_assignments_restaurant
  ON public.table_assignments (restaurant_id);

CREATE INDEX IF NOT EXISTS idx_table_assignments_staff
  ON public.table_assignments (staff_user_id);