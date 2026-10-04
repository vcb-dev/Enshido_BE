-- Gộp đơn tạo (intake_orders) vào production_orders: một bản ghi đi suốt từ tạo đơn đến Nguội.

-- AlterTable
ALTER TABLE "production_orders"
  ADD COLUMN "intake_seq" INTEGER,
  ADD COLUMN "intake_code" TEXT,
  ADD COLUMN "sx_code" TEXT,
  ADD COLUMN "product_name" TEXT,
  ADD COLUMN "has_mold" BOOLEAN,
  ADD COLUMN "product_weight_gram" DECIMAL(18,4),
  ADD COLUMN "casting_tree_weight_gram" DECIMAL(18,4),
  ADD COLUMN "wax_checked_weight_gram" DECIMAL(18,4),
  ADD COLUMN "wax_checked_by_name" TEXT,
  ADD COLUMN "reject_reason" TEXT,
  ADD COLUMN "rejected_by_name" TEXT,
  ADD COLUMN "rejected_at" TIMESTAMP(3),
  ADD COLUMN "rework_of_order_id" UUID,
  ADD COLUMN "rework_of_sub_ticket_id" UUID,
  ADD COLUMN "rework_of_entry_id" UUID;

ALTER TABLE "casting_slip_orders" ADD COLUMN "order_id" UUID;

-- Bảng ánh xạ đơn tạo → lệnh sản xuất (đơn đã có lệnh dùng lại lệnh đó, đơn chưa có thì sinh lệnh mới).
CREATE TEMP TABLE "_intake_map" (
  "intake_id" UUID PRIMARY KEY,
  "order_id" UUID NOT NULL,
  "is_new" BOOLEAN NOT NULL
);

INSERT INTO "_intake_map" ("intake_id", "order_id", "is_new")
SELECT i."id", po."id", FALSE
FROM "intake_orders" i
JOIN "production_orders" po ON po."intake_order_id" = i."id";

INSERT INTO "_intake_map" ("intake_id", "order_id", "is_new")
SELECT i."id", gen_random_uuid(), TRUE
FROM "intake_orders" i
WHERE NOT EXISTS (SELECT 1 FROM "production_orders" po WHERE po."intake_order_id" = i."id");

-- Đơn tạo chưa có lệnh: sinh lệnh mới (mã A tiếp theo, trạng thái theo bảng ánh xạ).
-- Đơn WAIT_COOLING cũ chưa có lệnh coi như đã cắt cây: vào Nguội với mốc cắt = lần sửa cuối.
INSERT INTO "production_orders" (
  "id", "seq", "code", "status", "source", "request_type", "qty", "tracking_code", "model_3d_code",
  "model_3d_url", "closed_by", "description", "received_date", "due_date", "cut_at",
  "stone_count", "stone_weight", "created_by", "created_at", "updated_at"
)
SELECT
  m."order_id",
  (SELECT COALESCE(MAX("seq"), 0) FROM "production_orders") + ROW_NUMBER() OVER (ORDER BY i."seq"),
  'A' || LPAD(((SELECT COALESCE(MAX("seq"), 0) FROM "production_orders") + ROW_NUMBER() OVER (ORDER BY i."seq"))::text, 3, '0'),
  (CASE i."status"::text
    WHEN 'WAIT_COOLING' THEN 'WAIT_FILING'
    WHEN 'NEW' THEN 'PENDING_APPROVAL'
    WHEN 'IN_PROGRESS' THEN 'PENDING_APPROVAL'
    WHEN 'COMPLETED' THEN 'PENDING_APPROVAL'
    WHEN 'CANCELLED' THEN 'REJECTED'
    ELSE i."status"::text
  END)::"ProductionStatus",
  'NVL', i."request_type", i."qty", i."tracking_code", i."tracking_code",
  i."model3d_url", i."placed_by", i."description", i."created_date", i."due_date",
  CASE WHEN i."status"::text = 'WAIT_COOLING' THEN i."updated_at" END,
  i."stone_count_3d", i."stone_weight_3d_gram", i."placed_by", i."created_at", i."updated_at"
FROM "intake_orders" i
JOIN "_intake_map" m ON m."intake_id" = i."id" AND m."is_new";

-- Phần "đơn tạo" ghi lên lệnh (cả lệnh mới sinh lẫn lệnh đã có).
UPDATE "production_orders" po SET
  "intake_seq" = i."seq",
  "intake_code" = i."code",
  "sx_code" = i."sx_code",
  "product_name" = i."product_name",
  "has_mold" = i."has_mold",
  "product_weight_gram" = i."product_weight_gram",
  "casting_tree_weight_gram" = i."casting_tree_weight_gram",
  "wax_checked_weight_gram" = i."wax_checked_weight_gram",
  "wax_checked_by_name" = i."wax_checked_by_name",
  "reject_reason" = i."reject_reason",
  "rejected_by_name" = i."rejected_by_name",
  "rejected_at" = i."rejected_at",
  "rework_of_sub_ticket_id" = i."rework_of_sub_ticket_id",
  "rework_of_entry_id" = i."rework_of_entry_id"
FROM "intake_orders" i
JOIN "_intake_map" m ON m."intake_id" = i."id"
WHERE po."id" = m."order_id";

-- Đơn bù: trỏ về lệnh gốc.
UPDATE "production_orders" po SET "rework_of_order_id" = i."rework_of_order_id"
FROM "intake_orders" i
JOIN "_intake_map" m ON m."intake_id" = i."id"
WHERE po."id" = m."order_id" AND i."rework_of_order_id" IS NOT NULL;

-- Ảnh đơn tạo → ảnh lệnh.
INSERT INTO "production_order_images" ("id", "order_id", "kind", "url", "public_id", "width", "height", "sort_order")
SELECT img."id", m."order_id", img."kind", img."url", img."public_id", img."width", img."height", img."sort_order"
FROM "intake_order_images" img
JOIN "_intake_map" m ON m."intake_id" = img."order_id";

-- Dòng phiếu đúc.
UPDATE "casting_slip_orders" l SET "order_id" = m."order_id"
FROM "_intake_map" m WHERE m."intake_id" = l."intake_order_id";

ALTER TABLE "casting_slip_orders" ALTER COLUMN "order_id" SET NOT NULL;

-- Bỏ cấu trúc cũ.
ALTER TABLE "casting_slip_orders" DROP CONSTRAINT "casting_slip_orders_intake_order_id_fkey";
DROP INDEX "casting_slip_orders_intake_order_id_key";
ALTER TABLE "casting_slip_orders" DROP COLUMN "intake_order_id";

ALTER TABLE "production_orders" DROP CONSTRAINT "production_orders_intake_order_id_fkey";
DROP INDEX "production_orders_intake_order_id_key";
ALTER TABLE "production_orders" DROP COLUMN "intake_order_id";

DROP TABLE "intake_order_images";
DROP TABLE "intake_orders";

-- CreateIndex
CREATE UNIQUE INDEX "casting_slip_orders_order_id_key" ON "casting_slip_orders"("order_id");
CREATE UNIQUE INDEX "production_orders_intake_seq_key" ON "production_orders"("intake_seq");
CREATE UNIQUE INDEX "production_orders_intake_code_key" ON "production_orders"("intake_code");
CREATE UNIQUE INDEX "production_orders_sx_code_key" ON "production_orders"("sx_code");
CREATE UNIQUE INDEX "production_orders_rework_of_entry_id_key" ON "production_orders"("rework_of_entry_id");
CREATE INDEX "production_orders_rework_of_order_id_idx" ON "production_orders"("rework_of_order_id");

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_rework_of_order_id_fkey" FOREIGN KEY ("rework_of_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "casting_slip_orders" ADD CONSTRAINT "casting_slip_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
