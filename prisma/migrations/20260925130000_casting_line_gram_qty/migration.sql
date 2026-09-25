-- Số gram theo từng NVL trên lệnh đúc (bỏ cột tổng trên header).
ALTER TABLE "casting_order_lines" ADD COLUMN "gram_qty" DECIMAL(18,4);

UPDATE "casting_order_lines" AS l
SET "gram_qty" = o."chi_qty"
FROM "casting_orders" AS o
WHERE o."id" = l."casting_order_id";

ALTER TABLE "casting_order_lines" ALTER COLUMN "gram_qty" SET NOT NULL;

ALTER TABLE "casting_orders" DROP COLUMN "chi_qty";
