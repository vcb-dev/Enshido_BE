-- Luồng khâu mới: Nguội → Vào đá → Khắc → Đánh bóng → Xi, kết thúc bằng Lỗi hoặc Hoàn thiện.
-- Bỏ khâu Ngoại Quan (KCS ngoại quan gộp vào bước Hoàn thiện); thêm trạng thái Khắc.
-- Đơn vào kho thành phẩm giờ do nút "Xác nhận hoàn thiện", không còn theo KCS nhận lại Ngoại Quan.
-- Chạy SAU file 2026-09-16_split_polish_plating.sql.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-16b_stage_flow.sql --schema prisma/schema.prisma

BEGIN;

-- Dừng lại nếu còn dữ liệu khâu Ngoại Quan: không có khâu tương đương để chuyển sang,
-- phải quyết định tay (xoá hoặc dời sang khâu khác) trước khi bỏ giá trị enum.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "production_stage_entries" WHERE "stage"::text = 'APPEARANCE') THEN
    RAISE EXCEPTION 'Còn khâu Ngoại Quan trong production_stage_entries — xử lý tay trước khi chạy migration';
  END IF;
END $$;

-- AlterEnum: ProductionStage (bỏ APPEARANCE, xếp lại Khắc trước Đánh bóng)
ALTER TYPE "ProductionStage" RENAME TO "ProductionStage_old";

CREATE TYPE "ProductionStage" AS ENUM ('FILING', 'STONE_SETTING', 'ENGRAVING', 'POLISHING', 'PLATING');

ALTER TABLE "production_stage_entries"
  ALTER COLUMN "stage" TYPE "ProductionStage" USING ("stage"::text::"ProductionStage");

DROP TYPE "ProductionStage_old";

-- AlterEnum: ProductionStatus (thêm ENGRAVING, xếp lại theo luồng)
ALTER TYPE "ProductionStatus" RENAME TO "ProductionStatus_old";

CREATE TYPE "ProductionStatus" AS ENUM ('NEW', 'REDO_3D', 'CASTING', 'FILING', 'STONE_SETTING', 'ENGRAVING', 'POLISHING', 'PLATING', 'DEFECT', 'FINISHING', 'DELIVERED');

ALTER TABLE "production_orders" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "production_orders"
  ALTER COLUMN "status" TYPE "ProductionStatus" USING ("status"::text::"ProductionStatus");

ALTER TABLE "production_orders" ALTER COLUMN "status" SET DEFAULT 'NEW';

ALTER TABLE "production_status_logs"
  ALTER COLUMN "from_status" TYPE "ProductionStatus" USING ("from_status"::text::"ProductionStatus");

ALTER TABLE "production_status_logs"
  ALTER COLUMN "to_status" TYPE "ProductionStatus" USING ("to_status"::text::"ProductionStatus");

DROP TYPE "ProductionStatus_old";

COMMIT;
