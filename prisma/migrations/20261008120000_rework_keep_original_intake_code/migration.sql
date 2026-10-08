-- Một đơn hàng có thể có nhiều lệnh bù; mã A / SX vẫn duy nhất theo lệnh.
DROP INDEX "production_orders_intake_seq_key";
DROP INDEX "production_orders_intake_code_key";
CREATE INDEX "production_orders_intake_seq_idx" ON "production_orders"("intake_seq");
CREATE INDEX "production_orders_intake_code_idx" ON "production_orders"("intake_code");

-- Giữ mã / số thứ tự đơn hàng duy nhất giữa các đơn gốc.
CREATE UNIQUE INDEX "production_orders_original_intake_seq_key"
  ON "production_orders"("intake_seq") WHERE "rework_of_order_id" IS NULL;
CREATE UNIQUE INDEX "production_orders_original_intake_code_key"
  ON "production_orders"("intake_code") WHERE "rework_of_order_id" IS NULL;

-- Phiếu bù đã tạo, kể cả bù tiếp một phiếu bù, dùng mã đơn hàng gốc.
WITH RECURSIVE original_codes AS (
  SELECT "id", "intake_seq", "intake_code"
  FROM "production_orders" WHERE "rework_of_order_id" IS NULL
  UNION ALL
  SELECT child."id", parent."intake_seq", parent."intake_code"
  FROM "production_orders" child
  JOIN original_codes parent ON child."rework_of_order_id" = parent."id"
)
UPDATE "production_orders" child
SET "intake_seq" = original."intake_seq", "intake_code" = original."intake_code",
    "updated_at" = CURRENT_TIMESTAMP
FROM original_codes original
WHERE child."id" = original."id" AND child."rework_of_order_id" IS NOT NULL
  AND (child."intake_seq" IS DISTINCT FROM original."intake_seq"
       OR child."intake_code" IS DISTINCT FROM original."intake_code");
