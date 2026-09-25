-- Lệnh đúc: mã đúc, số cối, NVL chụp từ Tồn và số chỉ.
CREATE TABLE "casting_orders" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "mold_count" INTEGER NOT NULL,
    "chi_qty" DECIMAL(18,4) NOT NULL,
    "material_id" UUID NOT NULL,
    "material_sku" TEXT,
    "material_name" TEXT NOT NULL,
    "location_code" TEXT,
    "category" TEXT,
    "material_type" TEXT,
    "shape" TEXT,
    "color" TEXT,
    "unit" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casting_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "casting_orders_code_key" ON "casting_orders"("code");
CREATE INDEX "casting_orders_created_at_idx" ON "casting_orders"("created_at");

ALTER TABLE "casting_orders"
    ADD CONSTRAINT "casting_orders_material_id_fkey"
    FOREIGN KEY ("material_id") REFERENCES "materials"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
