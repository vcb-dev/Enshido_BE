-- Chuẩn bị liên kết cho đơn chưa có lệnh trước migration gộp dữ liệu.
-- LPAD(text, 3) trong migration gộp cắt ngắn mã từ A1000 trở lên. Migration gộp đã áp ở
-- local nên giữ nguyên; cấp mã đủ chữ số tại đây để bước gộp chỉ dùng lại lệnh đã liên kết.
-- Máy đã gộp dữ liệu không còn intake_orders: migration này không cần làm gì.
DO $$
BEGIN
  IF to_regclass('"intake_orders"') IS NOT NULL THEN
    WITH pending AS (
      SELECT i.*, (SELECT COALESCE(MAX("seq"), 0) FROM "production_orders")
        + ROW_NUMBER() OVER (ORDER BY i."seq") AS order_seq
      FROM "intake_orders" i
      WHERE NOT EXISTS (
        SELECT 1 FROM "production_orders" po WHERE po."intake_order_id" = i."id"
      )
    )
    INSERT INTO "production_orders" (
      "id", "seq", "code", "status", "source", "request_type", "qty", "tracking_code",
      "model_3d_code", "model_3d_url", "closed_by", "description", "received_date", "due_date",
      "cut_at", "stone_count", "stone_weight", "created_by", "created_at", "updated_at",
      "intake_order_id"
    )
    SELECT
      gen_random_uuid(), i.order_seq,
      'A' || LPAD(i.order_seq::text, GREATEST(3, LENGTH(i.order_seq::text)), '0'),
      (CASE i."status"::text
        WHEN 'WAIT_COOLING' THEN 'WAIT_FILING'
        WHEN 'NEW' THEN 'PENDING_APPROVAL'
        WHEN 'IN_PROGRESS' THEN 'PENDING_APPROVAL'
        WHEN 'COMPLETED' THEN 'PENDING_APPROVAL'
        WHEN 'CANCELLED' THEN 'REJECTED'
        ELSE i."status"::text
      END)::"ProductionStatus",
      'NVL', i."request_type", i."qty", i."tracking_code", i."tracking_code", i."model3d_url",
      i."placed_by", i."description", i."created_date", i."due_date",
      CASE WHEN i."status"::text = 'WAIT_COOLING' THEN i."updated_at" END,
      i."stone_count_3d", i."stone_weight_3d_gram", i."placed_by", i."created_at", i."updated_at",
      i."id"
    FROM pending i;
  END IF;
END $$;
