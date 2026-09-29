ALTER TYPE "ProductionImageKind" ADD VALUE IF NOT EXISTS 'CASTING_TREE';

ALTER TABLE "intake_orders"
  ADD COLUMN IF NOT EXISTS "casting_tree_weight_gram" DECIMAL(18, 4);
