-- CreateEnum
CREATE TYPE "OutboundDraftStatus" AS ENUM ('DRAFT', 'POSTED', 'VOID');

-- AlterTable
ALTER TABLE "production_stone_holds" ADD COLUMN     "draft_id" UUID;

-- CreateTable
CREATE TABLE "stock_outbound_drafts" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unit_id" UUID,
    "unit_name" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "gram_qty" DECIMAL(18,4),
    "status" "OutboundDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "created_by_name" TEXT NOT NULL,
    "production_order_id" UUID NOT NULL,
    "posted_outbound_id" UUID,
    "closed_at" TIMESTAMP(3),
    "closed_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_outbound_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_outbound_drafts_posted_outbound_id_key" ON "stock_outbound_drafts"("posted_outbound_id");

-- CreateIndex
CREATE INDEX "stock_outbound_drafts_material_id_status_idx" ON "stock_outbound_drafts"("material_id", "status");

-- CreateIndex
CREATE INDEX "stock_outbound_drafts_warehouse_id_status_idx" ON "stock_outbound_drafts"("warehouse_id", "status");

-- CreateIndex
CREATE INDEX "stock_outbound_drafts_production_order_id_idx" ON "stock_outbound_drafts"("production_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_outbound_drafts_warehouse_id_sort_order_key" ON "stock_outbound_drafts"("warehouse_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "production_stone_holds_draft_id_key" ON "production_stone_holds"("draft_id");

-- AddForeignKey
ALTER TABLE "stock_outbound_drafts" ADD CONSTRAINT "stock_outbound_drafts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbound_drafts" ADD CONSTRAINT "stock_outbound_drafts_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbound_drafts" ADD CONSTRAINT "stock_outbound_drafts_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbound_drafts" ADD CONSTRAINT "stock_outbound_drafts_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_outbound_drafts" ADD CONSTRAINT "stock_outbound_drafts_posted_outbound_id_fkey" FOREIGN KEY ("posted_outbound_id") REFERENCES "stock_outbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stone_holds" ADD CONSTRAINT "production_stone_holds_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "stock_outbound_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Đá đang giữ chỗ từ trước khi có phiếu nháp: tạo phiếu xuất nháp tương ứng (dùng lại id của dòng
-- giữ chỗ) để khả dụng = tồn thực − phiếu nháp không bị lệch. STT đánh theo thứ tự cấp trong kho.
INSERT INTO "stock_outbound_drafts" (
  "id", "warehouse_id", "material_id", "sort_order", "issued_at", "name", "sku", "unit_id",
  "unit_name", "qty", "gram_qty", "status", "note", "created_by_name", "production_order_id",
  "created_at", "updated_at"
)
SELECT
  h.id, m.warehouse_id, h.material_id,
  ROW_NUMBER() OVER (PARTITION BY m.warehouse_id ORDER BY h.created_at, h.id),
  h.created_at, m.name, m.sku, m.unit_id, u.name, h.qty, h.weight, 'DRAFT',
  'Đá Vào đá — giữ chỗ có từ trước', h.created_by_name, h.order_id, h.created_at, NOW()
FROM "production_stone_holds" h
JOIN "materials" m ON m.id = h.material_id
JOIN "units" u ON u.id = m.unit_id
WHERE h.status = 'HELD';

UPDATE "production_stone_holds" SET "draft_id" = "id" WHERE "status" = 'HELD';
