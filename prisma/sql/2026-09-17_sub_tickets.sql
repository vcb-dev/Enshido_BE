-- Phiếu con cho thợ: đơn chia thành nhiều phiếu con (số lượng + gram bạc), thợ tự nhận
-- từng khâu, người giao xác nhận giao, KCS nhận lại riêng từng phiếu con.
-- Đơn có thêm Tổng TL bạc (mốc chia gram) và id người lên đơn (quyền chia phiếu).
-- created_by_user_id KHÔNG điền cho đơn cũ — không suy id từ tên; đơn cũ chỉ admin chia phiếu.
-- Chạy SAU file 2026-09-16d_drop_total_weight.sql.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-17_sub_tickets.sql --schema prisma/schema.prisma

BEGIN;

-- AlterTable
ALTER TABLE "production_orders"
  ADD COLUMN "silver_weight" DECIMAL(18,4),
  ADD COLUMN "created_by_user_id" UUID,
  ADD COLUMN "sub_ticket_seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "production_sub_tickets" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "no" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "silver_weight" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "pending_stage" "ProductionStage",
    "pending_at" TIMESTAMP(3),
    "pending_by_name" TEXT,
    "claimed_by_user_id" UUID,
    "claimed_by_name" TEXT,
    "claimed_at" TIMESTAMP(3),
    "last_printed_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_sub_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_sub_tickets_order_id_no_key" ON "production_sub_tickets"("order_id", "no");
CREATE INDEX "production_sub_tickets_pending_stage_claimed_by_user_id_idx" ON "production_sub_tickets"("pending_stage", "claimed_by_user_id");
CREATE INDEX "production_sub_tickets_claimed_by_user_id_idx" ON "production_sub_tickets"("claimed_by_user_id");

ALTER TABLE "production_sub_tickets" ADD CONSTRAINT "production_sub_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: khâu gắn phiếu con
ALTER TABLE "production_stage_entries" ADD COLUMN "sub_ticket_id" UUID;

ALTER TABLE "production_stage_entries" ADD CONSTRAINT "production_stage_entries_sub_ticket_id_fkey" FOREIGN KEY ("sub_ticket_id") REFERENCES "production_sub_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "production_stage_entries_sub_ticket_id_idx" ON "production_stage_entries"("sub_ticket_id");

-- Lần làm của khâu đếm riêng từng phiếu con. NULLS NOT DISTINCT để khâu cấp đơn
-- (sub_ticket_id null) vẫn không trùng khâu + lần như trước (PostgreSQL 15+).
DROP INDEX "production_stage_entries_order_id_stage_attempt_key";
CREATE UNIQUE INDEX "production_stage_entries_order_ticket_stage_attempt_key"
  ON "production_stage_entries"("order_id", "sub_ticket_id", "stage", "attempt") NULLS NOT DISTINCT;

COMMIT;
