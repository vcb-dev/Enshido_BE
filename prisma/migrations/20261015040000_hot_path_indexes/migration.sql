-- Index cho các truy vấn chạy nhiều nhất. Tên index đặt theo quy ước Prisma
-- (<bảng>_<cột>_idx) để `prisma migrate` không báo lệch schema.

-- Đá giữ theo đơn: mọi lần đọc chi tiết đơn và mọi thao tác sản xuất đều lọc theo order_id,
-- trước đây phải quét tuần tự cả bảng.
CREATE INDEX IF NOT EXISTS "production_stone_holds_order_id_idx"
  ON "production_stone_holds" ("order_id");

-- Xuất / nhả đá theo khâu lúc thủ kho xác nhận (chạy trong transaction có khóa dòng).
CREATE INDEX IF NOT EXISTS "production_stone_holds_stage_entry_id_status_idx"
  ON "production_stone_holds" ("stage_entry_id", "status");

-- Dọn ảnh cũ trên Cloudinary tra theo public_id. Đây là các bảng lớn nhanh nhất
-- và trước đây mỗi lần thay ảnh là bốn lần quét tuần tự.
CREATE INDEX IF NOT EXISTS "production_order_images_public_id_idx"
  ON "production_order_images" ("public_id");

CREATE INDEX IF NOT EXISTS "production_stage_images_public_id_idx"
  ON "production_stage_images" ("public_id");

CREATE INDEX IF NOT EXISTS "production_stone_hold_images_public_id_idx"
  ON "production_stone_hold_images" ("public_id");

CREATE INDEX IF NOT EXISTS "casting_slip_images_public_id_idx"
  ON "casting_slip_images" ("public_id");

-- Bảng KCS: các khâu chưa trả, xếp theo lúc giao.
CREATE INDEX IF NOT EXISTS "production_stage_entries_returned_at_handed_at_idx"
  ON "production_stage_entries" ("returned_at", "handed_at");

-- Hàng chờ thủ kho xác nhận: đã trả nhưng chưa xác nhận, xếp theo lúc trả.
CREATE INDEX IF NOT EXISTS "production_stage_entries_confirmed_at_returned_at_idx"
  ON "production_stage_entries" ("confirmed_at", "returned_at");
