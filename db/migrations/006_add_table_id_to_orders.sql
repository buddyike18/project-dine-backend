ALTER TABLE orders
ADD COLUMN IF NOT EXISTS table_id text;

CREATE INDEX IF NOT EXISTS idx_orders_restaurant_table_opened_at
ON orders (restaurant_id, table_id, opened_at DESC);
