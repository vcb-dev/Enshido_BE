-- Loại vàng/bạc chọn lúc tạo đơn.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrderMetalType') THEN
    CREATE TYPE "OrderMetalType" AS ENUM ('SILVER_925', 'GOLD_10K', 'GOLD_14K', 'GOLD_18K', 'GOLD_24K');
  END IF;
END
$$;

ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "metal_type" "OrderMetalType";
