ALTER TYPE "IntakeOrderStatus" ADD VALUE IF NOT EXISTS 'WAX_PRINTED';

ALTER TABLE "intake_orders"
  ADD COLUMN IF NOT EXISTS "product_weight_gram" DECIMAL(18, 4);
