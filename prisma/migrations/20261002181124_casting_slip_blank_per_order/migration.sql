-- AlterTable
ALTER TABLE "casting_slip_orders" ADD COLUMN     "blank_qty" INTEGER,
ADD COLUMN     "blank_weight_gram" DECIMAL(18,4);


-- Điền phôi đã cắt cho các phiếu đúc đã xác nhận, lấy từ phiếu nhập phôi tự tạo lúc cắt.
-- Đơn thường: phiếu nhập phôi gốc của lệnh sinh từ đơn tạo.
UPDATE "casting_slip_orders" cso
SET "blank_qty" = i."qty"::int,
    "blank_weight_gram" = i."gram_qty"
FROM "production_orders" po
JOIN "stock_inbounds" i ON i."id" = po."blank_inbound_id"
WHERE po."intake_order_id" = cso."intake_order_id";

-- Đơn bù: phiếu nhập "Phôi bù <mã đơn tạo> — …" cộng vào lệnh gốc.
UPDATE "casting_slip_orders" cso
SET "blank_qty" = i."qty"::int,
    "blank_weight_gram" = i."gram_qty"
FROM "intake_orders" io
JOIN "stock_inbounds" i
  ON i."production_order_id" = io."rework_of_order_id"
 AND i."note" LIKE 'Phôi bù ' || io."code" || ' —%'
WHERE io."id" = cso."intake_order_id"
  AND io."rework_of_order_id" IS NOT NULL
  AND cso."blank_qty" IS NULL;
