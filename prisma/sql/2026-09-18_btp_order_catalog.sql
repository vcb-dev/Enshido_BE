SET search_path TO enshido;

ALTER TABLE "production_orders"
  ADD COLUMN IF NOT EXISTS "btp_category" TEXT,
  ADD COLUMN IF NOT EXISTS "product_kind" TEXT;
