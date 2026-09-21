-- Mỗi khâu ghi thêm số lượng: giao bao nhiêu sản phẩm cho thợ, KCS nhận lại bao nhiêu.
-- Đơn cũ để trống (null) — không suy ra số lượng thay người làm.
-- Chạy SAU file 2026-09-16b_stage_flow.sql.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-16c_stage_qty.sql --schema prisma/schema.prisma

BEGIN;

ALTER TABLE "production_stage_entries"
  ADD COLUMN "handed_qty" INTEGER,
  ADD COLUMN "returned_qty" INTEGER;

COMMIT;
