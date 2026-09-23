ALTER TABLE "finished_goods_receipts"
ADD COLUMN "stocked_qty" INTEGER NOT NULL DEFAULT 0;

-- Các phiếu có trước thay đổi này đều đã được tính vào tồn.
UPDATE "finished_goods_receipts"
SET "stocked_qty" = "qty";
