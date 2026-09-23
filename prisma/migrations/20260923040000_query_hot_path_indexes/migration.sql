-- Chỉ mục cho lọc/sắp danh sách đơn và picker còn tồn (qty > 0).
CREATE INDEX IF NOT EXISTS "production_orders_status_seq_idx"
    ON "production_orders" ("status", "seq");
CREATE INDEX IF NOT EXISTS "production_orders_received_date_idx"
    ON "production_orders" ("received_date");
CREATE INDEX IF NOT EXISTS "production_orders_due_date_idx"
    ON "production_orders" ("due_date");
CREATE INDEX IF NOT EXISTS "production_orders_tracking_code_idx"
    ON "production_orders" ("tracking_code");
CREATE INDEX IF NOT EXISTS "production_orders_closed_by_idx"
    ON "production_orders" ("closed_by");
CREATE INDEX IF NOT EXISTS "stock_balances_warehouse_id_qty_idx"
    ON "stock_balances" ("warehouse_id", "qty");
