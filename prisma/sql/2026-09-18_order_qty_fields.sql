ALTER TABLE "production_orders"
  ADD COLUMN IF NOT EXISTS "qty_unit" TEXT,
  ADD COLUMN IF NOT EXISTS "finished_product_qty" INTEGER;
