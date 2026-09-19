SET search_path TO enshido;

INSERT INTO "warehouses" (
  "id", "code", "name", "short_name", "description", "sort_order", "is_active", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  'thanh-pham',
  'Kho thành phẩm',
  'Kho thành phẩm',
  'Nhập khi KCS nhận lại khâu Ngoại Quan. Xuất hàng cho khách.',
  4,
  true,
  now(),
  now()
WHERE NOT EXISTS (SELECT 1 FROM "warehouses" WHERE "code" = 'thanh-pham');

UPDATE "warehouses"
SET
  "name" = 'Kho thành phẩm',
  "short_name" = 'Kho thành phẩm',
  "description" = 'Nhập khi KCS nhận lại khâu Ngoại Quan. Xuất hàng cho khách.',
  "sort_order" = 4,
  "is_active" = true,
  "updated_at" = now()
WHERE "code" = 'thanh-pham';

UPDATE "users"
SET "allowed_screens" = array_append("allowed_screens", 'screen.warehouse.thanh-pham')
WHERE "role_code" <> 'ADMIN'
  AND NOT ('screen.warehouse.thanh-pham' = ANY ("allowed_screens"))
  AND (
    'screen.warehouse.nvl-chinh' = ANY ("allowed_screens")
    OR 'screen.warehouse.btp-cho-vao-da' = ANY ("allowed_screens")
    OR 'screen.warehouse.nvl-tieu-hao' = ANY ("allowed_screens")
  );
