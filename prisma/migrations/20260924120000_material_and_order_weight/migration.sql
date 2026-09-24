-- Trọng lượng NVL (g) — lên đơn và kho thành phẩm lấy sẵn.
ALTER TABLE "materials" ADD COLUMN "weight" DECIMAL(18,4);

-- Snapshot trọng lượng trên đơn sản xuất / thành phẩm.
ALTER TABLE "production_orders" ADD COLUMN "weight" DECIMAL(18,4);
