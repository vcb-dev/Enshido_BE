-- Hai loại đơn: Đơn NVL (như cũ) / Đơn BTP (lấy BTP có sẵn theo mã, tự xuất kho BTP, bỏ 3D + Đúc).
-- Kho BTP khai báo thêm màu xi, màu đá (color_id có sẵn), size (size_label có sẵn), ảnh.
-- Chạy SAU file 2026-09-14c_production_phase2.sql. Chỉ thêm cột / bảng mới; đơn cũ mặc định là Đơn NVL.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-14d_order_source_btp.sql --schema prisma/schema.prisma

BEGIN;

-- CreateEnum
CREATE TYPE "ProductionSource" AS ENUM ('NVL', 'BTP');

-- AlterTable
ALTER TABLE "materials" ADD COLUMN     "plating_color_id" UUID;

-- AlterTable
ALTER TABLE "stock_outbounds" ADD COLUMN     "auto_issued" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "production_orders" ADD COLUMN     "btp_material_id" UUID,
ADD COLUMN     "source" "ProductionSource" NOT NULL DEFAULT 'NVL';

-- CreateTable
CREATE TABLE "material_images" (
    "id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "material_images_material_id_sort_order_idx" ON "material_images"("material_id", "sort_order");

-- CreateIndex
CREATE INDEX "material_images_public_id_idx" ON "material_images"("public_id");

-- CreateIndex
CREATE INDEX "materials_plating_color_id_idx" ON "materials"("plating_color_id");

-- CreateIndex
CREATE INDEX "production_orders_btp_material_id_idx" ON "production_orders"("btp_material_id");

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_plating_color_id_fkey" FOREIGN KEY ("plating_color_id") REFERENCES "other_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_images" ADD CONSTRAINT "material_images_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_btp_material_id_fkey" FOREIGN KEY ("btp_material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Danh mục Màu xi cho kho BTP (sửa được ở Cấu hình). Server cũng tự tạo nếu thiếu.
INSERT INTO "other_classes" ("id", "code", "name", "kind", "parent_id", "sort_order", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'mau-xi', 'Màu xi', 'OTHER', NULL, 12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "other_classes" ("id", "code", "name", "kind", "parent_id", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), v.code, v.name, 'OTHER', p.id, v.sort_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  VALUES
    ('mau-xi-trang', 'Trắng', 1),
    ('mau-xi-vang', 'Vàng', 2),
    ('mau-xi-vang-hong', 'Vàng hồng', 3),
    ('mau-xi-den', 'Đen', 4)
) AS v(code, name, sort_order)
JOIN "other_classes" p ON p.code = 'mau-xi'
ON CONFLICT ("code") DO NOTHING;

COMMIT;
