-- Trường lên đơn gắn từng mã NVL (màu xi, số lượng, đá, khắc, yêu cầu).
ALTER TABLE "production_order_bom_lines"
    ADD COLUMN "plating_color" TEXT,
    ADD COLUMN "qty" INTEGER,
    ADD COLUMN "stone_weight" DECIMAL(18,4),
    ADD COLUMN "laser_engraving" TEXT,
    ADD COLUMN "other_requirements" TEXT;
