-- Lỗi / Hoàn thiện tính riêng từng phiếu con: mỗi phiếu tự kết thúc ở một trong hai nhánh,
-- phiếu mẹ chỉ chốt trạng thái khi mọi phiếu con đã có kết cục. Số lượng phiếu hoàn thiện
-- cộng dồn ngay vào phiếu nhập kho thành phẩm của đơn.
-- Chạy SAU file 2026-09-17_sub_tickets.sql.
-- outcome KHÔNG điền cho phiếu cũ — không suy kết cục / người chốt của phiếu đã có sẵn.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-18_sub_ticket_outcome.sql --schema prisma/schema.prisma

BEGIN;

-- CreateEnum
CREATE TYPE "SubTicketOutcome" AS ENUM ('DEFECT', 'FINISH');

-- AlterTable
ALTER TABLE "production_sub_tickets"
  ADD COLUMN "outcome" "SubTicketOutcome",
  ADD COLUMN "outcome_at" TIMESTAMP(3),
  ADD COLUMN "outcome_by_user_id" UUID,
  ADD COLUMN "outcome_by_name" TEXT,
  ADD COLUMN "outcome_stage" "ProductionStage",
  ADD COLUMN "outcome_qty" INTEGER,
  ADD COLUMN "outcome_note" TEXT;

COMMIT;
