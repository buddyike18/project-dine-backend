  

BEGIN;

-- 002_order_events.sql
-- Immutable audit trail for all order lifecycle events.

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role text,
  event_type text NOT NULL,
  from_status order_status,
  to_status order_status,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_order_events_order_id
  ON order_events(order_id);

CREATE INDEX IF NOT EXISTS idx_order_events_restaurant_id
  ON order_events(restaurant_id);

CREATE INDEX IF NOT EXISTS idx_order_events_created_at
  ON order_events(created_at);

COMMIT;