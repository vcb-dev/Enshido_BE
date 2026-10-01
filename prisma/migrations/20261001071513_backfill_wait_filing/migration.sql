-- Đơn đã cắt cây nhưng chưa mở khâu nào (chưa có lần giao, chưa có khâu chờ thợ nhận)
-- chuyển từ "Nguội" sang "Chờ nguội" (I). Đơn đã có khâu giữ nguyên — trạng thái được tính lại
-- ở thao tác kế tiếp.
WITH moved AS (
  UPDATE "production_orders" o
  SET "status" = 'WAIT_FILING'
  WHERE o."status" = 'FILING'
    AND o."pending_stage" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "production_stage_entries" e WHERE e."order_id" = o."id")
    AND NOT EXISTS (
      SELECT 1 FROM "production_sub_tickets" t
      WHERE t."order_id" = o."id" AND t."pending_stage" IS NOT NULL
    )
  RETURNING o."id"
)
INSERT INTO "production_status_logs" ("id", "order_id", "from_status", "to_status", "note", "changed_by", "changed_at")
SELECT gen_random_uuid(), "id", 'FILING', 'WAIT_FILING', 'Chuyển sang trạng thái Chờ nguội (I)', 'Hệ thống', now()
FROM moved;
