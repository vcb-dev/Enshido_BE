-- Một lệnh đúc có nhiều NVL. Chuyển NVL đang gắn trên lệnh sang dòng con.
CREATE TABLE "casting_order_lines" (
    "id" UUID NOT NULL,
    "casting_order_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "material_id" UUID NOT NULL,
    "material_sku" TEXT,
    "material_name" TEXT NOT NULL,
    "location_code" TEXT,
    "category" TEXT,
    "material_type" TEXT,
    "shape" TEXT,
    "color" TEXT,
    "unit" TEXT NOT NULL,

    CONSTRAINT "casting_order_lines_pkey" PRIMARY KEY ("id")
);

INSERT INTO "casting_order_lines" (
    "id",
    "casting_order_id",
    "sort_order",
    "material_id",
    "material_sku",
    "material_name",
    "location_code",
    "category",
    "material_type",
    "shape",
    "color",
    "unit"
)
SELECT
    gen_random_uuid(),
    "id",
    0,
    "material_id",
    "material_sku",
    "material_name",
    "location_code",
    "category",
    "material_type",
    "shape",
    "color",
    "unit"
FROM "casting_orders";

CREATE INDEX "casting_order_lines_casting_order_id_sort_order_idx"
    ON "casting_order_lines"("casting_order_id", "sort_order");
CREATE INDEX "casting_order_lines_material_id_idx"
    ON "casting_order_lines"("material_id");

ALTER TABLE "casting_order_lines"
    ADD CONSTRAINT "casting_order_lines_casting_order_id_fkey"
    FOREIGN KEY ("casting_order_id") REFERENCES "casting_orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "casting_order_lines"
    ADD CONSTRAINT "casting_order_lines_material_id_fkey"
    FOREIGN KEY ("material_id") REFERENCES "materials"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "casting_orders" DROP CONSTRAINT "casting_orders_material_id_fkey";
ALTER TABLE "casting_orders"
    DROP COLUMN "material_id",
    DROP COLUMN "material_sku",
    DROP COLUMN "material_name",
    DROP COLUMN "location_code",
    DROP COLUMN "category",
    DROP COLUMN "material_type",
    DROP COLUMN "shape",
    DROP COLUMN "color",
    DROP COLUMN "unit";
