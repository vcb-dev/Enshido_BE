-- Đúc dịch vụ: lưu đơn giá dịch vụ thay cho thạch cao đã dùng.
ALTER TABLE "casting_slips" ADD COLUMN "service_unit_price" DECIMAL(18,2);
