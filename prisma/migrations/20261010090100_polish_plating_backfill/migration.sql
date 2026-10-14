-- Khắc → Đánh bóng → Xi theo mô tả luồng bước 19–22: đưa phiếu đang dở về đúng trạng thái mới.
-- Chỉ suy từ dữ liệu đã có; không tự chốt đạt thay QC cho phiếu cũ đã qua Xi (QC bấm ở màn Phiếu QC).

-- 1. Lượt nhận kiểu cũ trên phiếu mẹ (thợ tự nhận, chờ người giao cân bạc "Xác nhận giao") không
--    còn bước xác nhận: Khắc → huỷ mở khâu để thủ kho "Giao Khắc" lại; Đánh bóng / Xi → gỡ lượt
--    nhận, phiếu về chờ thợ tự nhận.
UPDATE "production_orders"
SET pending_stage = NULL, pending_at = NULL, pending_by_name = NULL,
    claimed_by_user_id = NULL, claimed_by_name = NULL, claimed_at = NULL
WHERE pending_stage = 'ENGRAVING' AND pending_handover IS NULL;

UPDATE "production_orders"
SET claimed_by_user_id = NULL, claimed_by_name = NULL, claimed_at = NULL
WHERE pending_stage IN ('POLISHING', 'PLATING')
  AND pending_handover IS NULL
  AND claimed_by_user_id IS NOT NULL;

-- 2. Phiếu con đang rảnh mà khâu gần nhất là Khắc / Đánh bóng đã được QC nhận lại (đạt > 0):
--    tự mở khâu kế cho thợ tự nhận — người mở là QC đã nhận lại khâu đó.
UPDATE "production_sub_tickets" t
SET pending_stage = CASE last.stage WHEN 'ENGRAVING' THEN 'POLISHING' ELSE 'PLATING' END::"ProductionStage",
    pending_at = last.returned_at,
    pending_by_name = last.returned_by_name
FROM (
  SELECT DISTINCT ON (sub_ticket_id) sub_ticket_id, stage, returned_at, returned_by_name, returned_qty
  FROM "production_stage_entries"
  WHERE sub_ticket_id IS NOT NULL
  ORDER BY sub_ticket_id, created_at DESC
) last
JOIN "production_orders" o ON TRUE
WHERE last.sub_ticket_id = t.id
  AND o.id = t.order_id
  AND o.status <> 'DELIVERED'
  AND t.outcome IS NULL
  AND t.pending_stage IS NULL
  AND last.stage IN ('ENGRAVING', 'POLISHING')
  AND last.returned_at IS NOT NULL
  AND COALESCE(last.returned_qty, 0) > 0;

-- 3. Cũng vậy với phiếu mẹ của đơn không chia phiếu con, còn đang ở các khâu.
UPDATE "production_orders" o
SET pending_stage = CASE last.stage WHEN 'ENGRAVING' THEN 'POLISHING' ELSE 'PLATING' END::"ProductionStage",
    pending_at = last.returned_at,
    pending_by_name = last.returned_by_name
FROM (
  SELECT DISTINCT ON (order_id) order_id, stage, returned_at, returned_by_name, returned_qty
  FROM "production_stage_entries"
  WHERE sub_ticket_id IS NULL
  ORDER BY order_id, created_at DESC
) last
WHERE last.order_id = o.id
  AND o.pending_stage IS NULL
  AND o.status IN ('ENGRAVING', 'POLISHING', 'PLATING')
  AND NOT EXISTS (SELECT 1 FROM "production_sub_tickets" t WHERE t.order_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM "finished_goods_receipts" r WHERE r.order_id = o.id)
  AND last.stage IN ('ENGRAVING', 'POLISHING')
  AND last.returned_at IS NOT NULL
  AND COALESCE(last.returned_qty, 0) > 0;

-- 4. Đơn không chia phiếu đang chờ thợ nhận Đánh bóng / Xi: Q Chờ đánh bóng / S Chờ xi (trước đây
--    hai khâu này không có trạng thái chờ riêng). Đơn đã chia tự tính lại ở thao tác kế tiếp.
UPDATE "production_orders" o
SET status = CASE o.pending_stage WHEN 'POLISHING' THEN 'WAIT_POLISHING' ELSE 'WAIT_PLATING' END::"ProductionStatus"
WHERE o.pending_stage IN ('POLISHING', 'PLATING')
  AND o.status IN ('ENGRAVING', 'POLISHING', 'PLATING')
  AND NOT EXISTS (SELECT 1 FROM "production_sub_tickets" t WHERE t.order_id = o.id)
  AND NOT EXISTS (
    SELECT 1 FROM "production_stage_entries" e
    WHERE e.order_id = o.id AND e.sub_ticket_id IS NULL AND e.returned_at IS NULL
  );

-- 5. Đơn đã chốt đạt nhưng kho thành phẩm chưa nhận đủ: U Đã xi xong. Nhận đủ mới là V Sản xuất xong.
UPDATE "production_orders" o
SET status = 'PLATED'
FROM "finished_goods_receipts" r
WHERE r.order_id = o.id
  AND o.status = 'FINISHING'
  AND r.stocked_qty < r.qty;
