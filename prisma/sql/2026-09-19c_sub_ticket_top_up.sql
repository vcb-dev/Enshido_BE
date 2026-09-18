-- Cấp thêm SL / bạc cho phiếu con khi thợ làm giữa chừng phát hiện thiếu.
-- Cấp lúc thợ đang làm thì cộng thẳng vào TL bạc giao của khâu đó, nếu không công thức
-- hao hụt (giao − nhận lại − thu hồi) sẽ ra số âm. Cấp lúc phiếu rảnh thì để stage_entry_id
-- null, phần đó vào khâu được giao kế tiếp.
-- Chạy SAU file 2026-09-19b_stage_submitted.sql.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-19c_sub_ticket_top_up.sql --schema prisma/schema.prisma

BEGIN;

-- CreateTable
CREATE TABLE "production_sub_ticket_top_ups" (
    "id" UUID NOT NULL,
    "sub_ticket_id" UUID NOT NULL,
    "stage_entry_id" UUID,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "silver_weight" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_sub_ticket_top_ups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "production_sub_ticket_top_ups_sub_ticket_id_idx" ON "production_sub_ticket_top_ups"("sub_ticket_id");
CREATE INDEX "production_sub_ticket_top_ups_stage_entry_id_idx" ON "production_sub_ticket_top_ups"("stage_entry_id");

ALTER TABLE "production_sub_ticket_top_ups" ADD CONSTRAINT "production_sub_ticket_top_ups_sub_ticket_id_fkey"
  FOREIGN KEY ("sub_ticket_id") REFERENCES "production_sub_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_sub_ticket_top_ups" ADD CONSTRAINT "production_sub_ticket_top_ups_stage_entry_id_fkey"
  FOREIGN KEY ("stage_entry_id") REFERENCES "production_stage_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
