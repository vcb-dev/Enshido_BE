-- Lý do hàng lỗi KCS ghi lúc nhận lại khâu — tách khỏi ghi chú chung của khâu để hiện ở cột Lỗi.
ALTER TABLE "production_stage_entries" ADD COLUMN "defect_reason" TEXT;
