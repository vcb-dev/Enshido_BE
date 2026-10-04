-- Đá ở kho NVL tính theo ct thay vì gram (1 ct = 0,2 g).
-- Mã đá (metal_kind = STONE) đang dùng đơn vị gram chuyển sang đơn vị ct: số lượng × 5, đơn giá ÷ 5,
-- thành tiền giữ nguyên. Cột TL (gram_qty, weight…) vẫn lưu theo g — mã gram trước đây để trống
-- gram_qty vì SL chính là TL, nay điền lại bằng SL cũ để TL không mất.

INSERT INTO "units" ("id", "code", "name", "sort_order")
SELECT gen_random_uuid(), 'ct', 'ct', COALESCE((SELECT MAX("sort_order") + 1 FROM "units"), 0)
WHERE NOT EXISTS (SELECT 1 FROM "units" WHERE "code" = 'ct');

CREATE TEMP TABLE "_stone_to_ct" ON COMMIT DROP AS
SELECT m."id"
FROM "materials" m
JOIN "units" u ON u."id" = m."unit_id"
WHERE u."code" = 'gram' AND m."metal_kind" = 'STONE';

UPDATE "stock_balances" SET
  "opening_qty" = "opening_qty" * 5,
  "in_qty" = "in_qty" * 5,
  "out_qty" = "out_qty" * 5,
  "qty" = "qty" * 5,
  "counted_qty" = "counted_qty" * 5,
  "stock_unit_price" = ROUND("stock_unit_price" / 5, 2)
WHERE "material_id" IN (SELECT "id" FROM "_stone_to_ct");

UPDATE "stock_inbounds" SET
  "gram_qty" = COALESCE("gram_qty", "qty"),
  "qty" = "qty" * 5,
  "unit_price" = ROUND("unit_price" / 5, 2),
  "stock_unit_price" = ROUND("stock_unit_price" / 5, 2)
WHERE "material_id" IN (SELECT "id" FROM "_stone_to_ct");

UPDATE "stock_outbounds" SET
  "gram_qty" = COALESCE("gram_qty", "qty"),
  "qty" = "qty" * 5,
  "stock_unit_price" = ROUND("stock_unit_price" / 5, 2),
  "inbound_unit_price" = ROUND("inbound_unit_price" / 5, 2)
WHERE "material_id" IN (SELECT "id" FROM "_stone_to_ct");

UPDATE "stock_outbound_drafts" SET
  "gram_qty" = COALESCE("gram_qty", "qty"),
  "qty" = "qty" * 5
WHERE "material_id" IN (SELECT "id" FROM "_stone_to_ct");

UPDATE "production_material_requests" SET
  "requested_qty" = "requested_qty" * 5,
  "issued_qty" = "issued_qty" * 5
WHERE "material_id" IN (SELECT "id" FROM "_stone_to_ct");

UPDATE "production_stone_holds" SET
  "qty" = "qty" * 5,
  "early_returned_qty" = "early_returned_qty" * 5
WHERE "material_id" IN (SELECT "id" FROM "_stone_to_ct");

UPDATE "materials" SET
  "unit_id" = (SELECT "id" FROM "units" WHERE "code" = 'ct'),
  "reorder_point" = "reorder_point" * 5
WHERE "id" IN (SELECT "id" FROM "_stone_to_ct");
