ALTER TYPE "IntakeOrderStatus" ADD VALUE IF NOT EXISTS 'WAX_CONFIRMED';

-- Luồng cũ: chờ TK sau số liệu sáp (chưa cây thông) → coi như đã in sáp (D).
UPDATE "intake_orders"
SET "status" = 'WAX_PRINTED'
WHERE "status" = 'PENDING_WAREHOUSE_CONFIRMATION'
  AND "casting_tree_weight_gram" IS NULL;
