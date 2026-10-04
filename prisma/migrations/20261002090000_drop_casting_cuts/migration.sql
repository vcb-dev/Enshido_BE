-- Bỏ hẳn luồng cắt cây thông: phôi cân ở bước xác nhận phiếu đúc (mô tả luồng bước 9 → 11).
-- Trước khi xoá bảng, chép phôi của phiếu cắt cũ sang chính đơn sản xuất để đơn cũ vẫn giao
-- Nguội / xuất phôi được, và chép ảnh cân phôi sang ảnh đơn (CUT_BLANK).

-- 1. Phôi: lấy dòng cắt mới nhất của mỗi đơn chưa có phôi ghi trên đơn.
UPDATE "production_orders" o
SET "blank_material_id" = l."btp_material_id",
    "blank_inbound_id" = l."btp_inbound_id",
    "blank_qty" = l."qty",
    "blank_weight" = l."weight"
FROM (
  SELECT DISTINCT ON ("order_id") "order_id", "btp_material_id", "btp_inbound_id", "qty", "weight"
  FROM "casting_cut_lines"
  ORDER BY "order_id", "created_at" DESC
) l
WHERE o."id" = l."order_id" AND o."blank_material_id" IS NULL;

-- 2. Ảnh cân phôi của từng đơn.
INSERT INTO "production_order_images" ("id", "order_id", "kind", "url", "public_id", "width", "height", "sort_order", "created_at")
SELECT gen_random_uuid(), l."order_id", 'CUT_BLANK', i."url", i."public_id", i."width", i."height", i."sort_order", i."created_at"
FROM "casting_cut_images" i
JOIN "casting_cut_lines" l ON l."id" = i."line_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "production_order_images" p
  WHERE p."order_id" = l."order_id" AND p."public_id" = i."public_id"
);

-- 3. Xoá bảng phiếu cắt.
-- DropForeignKey
ALTER TABLE "casting_cut_images" DROP CONSTRAINT "casting_cut_images_cut_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cut_images" DROP CONSTRAINT "casting_cut_images_line_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cut_lines" DROP CONSTRAINT "casting_cut_lines_btp_inbound_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cut_lines" DROP CONSTRAINT "casting_cut_lines_btp_material_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cut_lines" DROP CONSTRAINT "casting_cut_lines_cut_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cut_lines" DROP CONSTRAINT "casting_cut_lines_order_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cuts" DROP CONSTRAINT "casting_cuts_casting_order_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cuts" DROP CONSTRAINT "casting_cuts_casting_slip_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cuts" DROP CONSTRAINT "casting_cuts_rest_inbound_id_fkey";

-- DropForeignKey
ALTER TABLE "casting_cuts" DROP CONSTRAINT "casting_cuts_rest_material_id_fkey";

-- DropTable
DROP TABLE "casting_cut_images";

-- DropTable
DROP TABLE "casting_cut_lines";

-- DropTable
DROP TABLE "casting_cuts";

