-- Trọng lượng ước tính trên phiếu đúc, tách với số thực xuất.
ALTER TABLE "casting_slips"
ADD COLUMN IF NOT EXISTS "estimate_s999_gram" DECIMAL(18, 4),
ADD COLUMN IF NOT EXISTS "estimate_master_alloy_gram" DECIMAL(18, 4),
ADD COLUMN IF NOT EXISTS "estimate_s925_gram" DECIMAL(18, 4);
