-- Đồng bộ đơn đã nộp kết quả đúc nhưng intake còn CASTING.
UPDATE "intake_orders" io
SET status = 'CAST_PENDING_CONFIRMATION'
FROM "casting_slip_orders" cso
JOIN "casting_slips" cs ON cs.id = cso.slip_id
WHERE cso.intake_order_id = io.id
  AND cs.status = 'PENDING_CONFIRMATION'
  AND io.status = 'CASTING';
