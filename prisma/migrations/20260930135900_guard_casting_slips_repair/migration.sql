-- Chặn 20260930140000_db_schema_repair đổi tên bảng phiếu đúc đang dùng.
-- Migration đó đổi tên casting_slips → casting_slips_legacy_workflow khi bảng có cột `status` mà
-- không có `intake_order_id` — đúng là cấu trúc hiện hành sau 20260929140000_casting_slip_batch,
-- nên mọi DB đã chạy tới đó sẽ mất phiếu đúc (bảng mới rỗng) và 20261002120000 còn xoá luôn các
-- dòng casting_slip_orders "mồ côi". Thêm tạm cột rỗng để điều kiện đổi tên không còn đúng;
-- 20261002120000_casting_slips_schema_repair tự xoá cột này (không có dòng nào để chuyển).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'casting_slips' AND column_name = 'status'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'casting_slips' AND column_name = 'intake_order_id'
    ) THEN
        ALTER TABLE "casting_slips" ADD COLUMN "intake_order_id" UUID;
    END IF;
END $$;
