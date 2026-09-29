-- Bước 1: thêm giá trị enum (phải commit trước khi dùng — migration riêng).
ALTER TYPE "IntakeOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
