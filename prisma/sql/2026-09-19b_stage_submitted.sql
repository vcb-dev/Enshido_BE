-- Thợ báo đã làm xong: thêm một mắt xích giữa "thợ đang làm" và "KCS nhận lại".
-- Thợ bấm nộp -> phiếu con sang trạng thái chờ KCS cân lại, KCS biết phiếu nào tới lượt mình.
-- Đây là TÍN HIỆU, không phải cổng chặn: KCS vẫn nhận lại được khi thợ chưa bấm,
-- nên mọi khâu cũ (submitted_at = NULL) chạy y như trước.
-- Chạy SAU file 2026-09-19_role_worker.sql.
-- KHÔNG điền submitted_at cho khâu cũ — không suy đoán thời điểm thợ nộp cho dữ liệu đã có.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-19b_stage_submitted.sql --schema prisma/schema.prisma

BEGIN;

-- AlterTable
ALTER TABLE "production_stage_entries"
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "submitted_by_user_id" UUID,
  ADD COLUMN "submitted_by_name" TEXT;

COMMIT;
