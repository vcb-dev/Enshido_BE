-- NVL cấu thành thành phẩm (tab Tồn kho thành phẩm).
CREATE TABLE "production_order_bom_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "production_order_bom_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "production_order_bom_lines_order_id_sort_order_idx" ON "production_order_bom_lines"("order_id", "sort_order");

CREATE UNIQUE INDEX "production_order_bom_lines_order_id_material_id_key" ON "production_order_bom_lines"("order_id", "material_id");

ALTER TABLE "production_order_bom_lines" ADD CONSTRAINT "production_order_bom_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_order_bom_lines" ADD CONSTRAINT "production_order_bom_lines_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
