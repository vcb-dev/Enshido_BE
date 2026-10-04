-- Đá tấm tính theo ct chuyển sang gram (người dùng chốt 2026-10-02): kho NVL theo dõi đá bằng
-- trọng lượng. Carat là đơn vị khối lượng nên quy đổi chính xác 1 ct = 0,2 g — SL × 0,2, đơn giá
-- / 0,2 (× 5), thành tiền giữ nguyên. Không cân lại, không đặt số mới.
-- Đá đang gắn nhầm loại SILVER: sang gram mà giữ SILVER thì bị tính vào giá bạc của đơn
-- (production-costing) và gợi ý thành bạc khi xin xuất — đổi sang STONE.

-- Mã đá tính theo ct — bảng materials đổi đơn vị ở câu cuối nên các câu trên vẫn lọc đúng.

UPDATE "stock_balances"
SET opening_qty = opening_qty * 0.2,
    in_qty = in_qty * 0.2,
    out_qty = out_qty * 0.2,
    qty = qty * 0.2,
    counted_qty = counted_qty * 0.2,
    stock_unit_price = stock_unit_price * 5
WHERE material_id IN (SELECT m.id FROM "materials" m JOIN "units" u ON u.id = m.unit_id WHERE u.code = 'ct');

UPDATE "stock_inbounds"
SET qty = qty * 0.2,
    gram_qty = COALESCE(gram_qty, qty * 0.2),
    unit_price = unit_price * 5,
    stock_unit_price = stock_unit_price * 5,
    unit_id = (SELECT id FROM "units" WHERE code = 'gram'),
    unit_name = (SELECT name FROM "units" WHERE code = 'gram')
WHERE material_id IN (SELECT m.id FROM "materials" m JOIN "units" u ON u.id = m.unit_id WHERE u.code = 'ct');

UPDATE "stock_outbounds"
SET qty = qty * 0.2,
    gram_qty = COALESCE(gram_qty, qty * 0.2),
    inbound_unit_price = inbound_unit_price * 5,
    stock_unit_price = stock_unit_price * 5,
    unit_id = (SELECT id FROM "units" WHERE code = 'gram'),
    unit_name = (SELECT name FROM "units" WHERE code = 'gram')
WHERE material_id IN (SELECT m.id FROM "materials" m JOIN "units" u ON u.id = m.unit_id WHERE u.code = 'ct');

UPDATE "production_material_requests"
SET requested_qty = requested_qty * 0.2,
    issued_qty = issued_qty * 0.2
WHERE material_id IN (SELECT m.id FROM "materials" m JOIN "units" u ON u.id = m.unit_id WHERE u.code = 'ct');

UPDATE "production_stone_holds"
SET qty = qty * 0.2,
    early_returned_qty = early_returned_qty * 0.2
WHERE material_id IN (SELECT m.id FROM "materials" m JOIN "units" u ON u.id = m.unit_id WHERE u.code = 'ct');

UPDATE "materials"
SET unit_id = (SELECT id FROM "units" WHERE code = 'gram'),
    metal_kind = 'STONE'
WHERE id IN (SELECT m.id FROM "materials" m JOIN "units" u ON u.id = m.unit_id WHERE u.code = 'ct');
