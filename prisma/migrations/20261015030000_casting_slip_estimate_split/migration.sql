-- Ước tính bạc phiếu đúc: nửa tổng (sáp × 24) là S925, nửa còn lại là S999 (92.5%) + hội pha.
-- Phiếu cũ lưu cả ba dòng bằng đúng tổng nên vá lại theo công thức mới.
-- wax * 24 / 2 = wax * 12.

UPDATE "casting_slips"
SET "estimate_s999_gram" = ROUND("wax_weight_gram" * 12 * 0.925, 4),
    "estimate_master_alloy_gram" =
      ROUND("wax_weight_gram" * 12, 4) - ROUND("wax_weight_gram" * 12 * 0.925, 4),
    "estimate_s925_gram" = ROUND("wax_weight_gram" * 12, 4)
WHERE "estimate_s999_gram" IS NOT NULL
  AND "estimate_s999_gram" = "estimate_master_alloy_gram"
  AND "estimate_master_alloy_gram" = "estimate_s925_gram";

-- Thực xuất chỉ vá phiếu mà thủ kho bỏ trống (hệ thống tự điền cả ba dòng = tổng).
-- Phiếu thủ kho nhập tay ba số bằng nhau thì giữ nguyên.
UPDATE "casting_slips"
SET "issue_s999_gram" = ROUND("wax_weight_gram" * 12 * 0.925, 4),
    "issue_master_alloy_gram" =
      ROUND("wax_weight_gram" * 12, 4) - ROUND("wax_weight_gram" * 12 * 0.925, 4),
    "issue_s925_gram" = ROUND("wax_weight_gram" * 12, 4)
WHERE "issue_s999_gram" IS NOT NULL
  AND "issue_s999_gram" = "issue_master_alloy_gram"
  AND "issue_master_alloy_gram" = "issue_s925_gram"
  AND "issue_s999_gram" = "wax_weight_gram" * 24;
