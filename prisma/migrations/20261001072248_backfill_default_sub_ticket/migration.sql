-- Đơn sinh từ phiếu đúc mặc định có một phiếu -1 (mô tả luồng bước 11: "mặc định 1 đơn là 1 phiếu").
-- Bù cho các đơn đã sinh trước đó mà chưa có phiếu con và chưa giao khâu nào trên phiếu mẹ.
WITH target AS (
  SELECT o."id", o."qty", COALESCE(o."created_by", 'Hệ thống') AS created_by_name
  FROM "production_orders" o
  WHERE o."intake_order_id" IS NOT NULL
    AND o."status" = 'WAIT_FILING'
    AND o."pending_stage" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "production_sub_tickets" t WHERE t."order_id" = o."id")
    AND NOT EXISTS (SELECT 1 FROM "production_stage_entries" e WHERE e."order_id" = o."id")
),
bumped AS (
  UPDATE "production_orders" o
  SET "sub_ticket_seq" = 1
  FROM target
  WHERE o."id" = target."id"
  RETURNING o."id"
)
INSERT INTO "production_sub_tickets" ("id", "order_id", "no", "qty", "created_by_name", "created_at", "updated_at")
SELECT gen_random_uuid(), target."id", 1, target."qty", target.created_by_name, now(), now()
FROM target;
