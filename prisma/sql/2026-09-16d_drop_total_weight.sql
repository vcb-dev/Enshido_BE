-- Bỏ trọng lượng tổng (cả đá) ở khâu: phiếu chỉ theo dõi trọng lượng bạc, vì hao hụt tính trên bạc.
-- Chạy SAU file 2026-09-16c_stage_qty.sql.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-16d_drop_total_weight.sql --schema prisma/schema.prisma

BEGIN;

ALTER TABLE "production_stage_entries"
  DROP COLUMN "handed_total_weight",
  DROP COLUMN "returned_total_weight";

COMMIT;
