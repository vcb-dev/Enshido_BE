-- Cấp vật tư phiếu đúc: thêm vàng xuất từ kho NVL chính (không ước tính từ sáp).
ALTER TABLE "casting_slips" ADD COLUMN "issue_gold_gram" DECIMAL(18,4);
