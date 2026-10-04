-- AlterTable
ALTER TABLE "production_stage_entries" ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_by_name" TEXT,
ADD COLUMN     "confirmed_by_user_id" UUID,
ADD COLUMN     "defect_qty" INTEGER,
ADD COLUMN     "output_material_id" UUID,
ADD COLUMN     "scrap_s999_weight" DECIMAL(18,4),
ADD COLUMN     "stock_inbound_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- Các lần KCS nhận lại đã có từ trước coi như đã xác nhận (chưa có bước thủ kho xác nhận).
UPDATE "production_stage_entries"
SET "confirmed_at" = "returned_at",
    "confirmed_by_name" = COALESCE("returned_by_name", 'Hệ thống')
WHERE "returned_at" IS NOT NULL;
