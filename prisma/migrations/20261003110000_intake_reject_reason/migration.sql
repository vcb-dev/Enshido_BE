-- Lưu lý do từ chối đơn tạo (trước đây FE gửi lên nhưng không có chỗ lưu), kèm người và lúc từ chối.
ALTER TABLE "intake_orders" ADD COLUMN "reject_reason" TEXT,
ADD COLUMN "rejected_at" TIMESTAMP(3),
ADD COLUMN "rejected_by_name" TEXT;
