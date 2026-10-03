-- 20260930110000_intake_remap_wait_cooling (main) coi WAIT_COOLING là trạng thái cũ và đổi về
-- WAIT_CASTING. Ở luồng hiện hành WAIT_COOLING = thủ kho đã xác nhận đúc + chia phôi (đơn đã vào
-- Nguội). Trả lại cho đơn đã có lệnh sản xuất hoặc đã có phôi ghi trên phiếu đúc.
UPDATE "intake_orders" io
SET "status" = 'WAIT_COOLING'
WHERE io."status" = 'WAIT_CASTING'
  AND (
    EXISTS (SELECT 1 FROM "production_orders" po WHERE po."intake_order_id" = io."id")
    OR EXISTS (
      SELECT 1 FROM "casting_slip_orders" cso
      WHERE cso."intake_order_id" = io."id" AND cso."blank_qty" IS NOT NULL
    )
  );

-- Cột tạm của 20260930135900_guard_casting_slips_repair còn sót trên DB đã chạy
-- casting_slips_schema_repair từ trước (không còn bước nào xoá nó): dọn khi cột rỗng.
DO $$
DECLARE
    has_value BOOLEAN;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'casting_slips' AND column_name = 'intake_order_id'
    ) THEN
        -- SQL động: cột có thể không tồn tại lúc dịch khối lệnh.
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM "casting_slips" WHERE "intake_order_id" IS NOT NULL)'
            INTO has_value;
        IF NOT has_value THEN
            EXECUTE 'ALTER TABLE "casting_slips" DROP CONSTRAINT IF EXISTS "casting_slips_intake_order_id_fkey"';
            EXECUTE 'DROP INDEX IF EXISTS "casting_slips_intake_order_id_idx"';
            EXECUTE 'DROP INDEX IF EXISTS "casting_slips_intake_order_id_key"';
            EXECUTE 'ALTER TABLE "casting_slips" DROP COLUMN "intake_order_id"';
        END IF;
    END IF;
END $$;
