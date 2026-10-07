-- Gộp "Tên thành phẩm" (btp_name) vào product_name: mọi nơi dùng chung một tên sản phẩm.
-- Giữ cột btp_name để quay lại được; xoá ở migration riêng sau khi chạy ổn định.
UPDATE "production_orders"
SET "product_name" = "btp_name"
WHERE ("product_name" IS NULL OR btrim("product_name") = '')
  AND "btp_name" IS NOT NULL
  AND btrim("btp_name") <> '';
