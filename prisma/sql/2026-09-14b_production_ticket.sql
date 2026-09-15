-- Phiếu sản xuất theo mẫu Excel: Đúc ở đầu phiếu, cột khâu Nguội → Ngoại Quan, KCS cân lại từng khâu.
-- Chạy SAU file 2026-09-14_production_orders.sql. Chỉ đụng tới các bảng production_* và enum KcsResult.
-- Áp lên DB: dán vào Supabase SQL Editor rồi Run (hoặc npx prisma db execute --file prisma/sql/2026-09-14b_production_ticket.sql --schema prisma/schema.prisma).

BEGIN;

-- Xóa đơn thử (người dùng đồng ý 2026-09-14): cấu trúc khâu cũ không chuyển sang được.
TRUNCATE production_status_logs, production_stage_entries, production_order_images, production_orders;

-- CreateEnum
CREATE TYPE "ProductionStage" AS ENUM ('FILING', 'STONE_SETTING', 'POLISH_PLATING', 'ENGRAVING', 'APPEARANCE');

-- AlterTable
ALTER TABLE "production_orders" DROP COLUMN "kcs_at",
DROP COLUMN "kcs_by_name",
DROP COLUMN "kcs_by_user_id",
DROP COLUMN "kcs_note",
DROP COLUMN "kcs_result",
ADD COLUMN     "casting_returned_date" DATE,
ADD COLUMN     "casting_sent_date" DATE,
ADD COLUMN     "due_date" DATE,
ADD COLUMN     "laser_engraving" TEXT,
ADD COLUMN     "other_requirements" TEXT,
ADD COLUMN     "size_label" TEXT,
ADD COLUMN     "stone_count" INTEGER,
ADD COLUMN     "stone_weight" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "production_stage_entries" DROP COLUMN "confirmed_at",
DROP COLUMN "confirmed_by_name",
DROP COLUMN "confirmed_by_user_id",
DROP COLUMN "handed_over_at",
DROP COLUMN "received_at",
DROP COLUMN "weight_in",
DROP COLUMN "weight_out",
ADD COLUMN     "btp_recovered_weight" DECIMAL(18,4),
ADD COLUMN     "handed_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "handed_by_name" TEXT NOT NULL,
ADD COLUMN     "handed_by_user_id" UUID,
ADD COLUMN     "handed_silver_weight" DECIMAL(18,4),
ADD COLUMN     "handed_total_weight" DECIMAL(18,4),
ADD COLUMN     "returned_at" TIMESTAMP(3),
ADD COLUMN     "returned_by_name" TEXT,
ADD COLUMN     "returned_by_user_id" UUID,
ADD COLUMN     "returned_silver_weight" DECIMAL(18,4),
ADD COLUMN     "returned_total_weight" DECIMAL(18,4),
ADD COLUMN     "silver_recovered_weight" DECIMAL(18,4),
DROP COLUMN "stage",
ADD COLUMN     "stage" "ProductionStage" NOT NULL;

-- DropEnum
DROP TYPE "KcsResult";

-- CreateIndex
CREATE UNIQUE INDEX "production_stage_entries_order_id_stage_attempt_key" ON "production_stage_entries"("order_id", "stage", "attempt");


COMMIT;
