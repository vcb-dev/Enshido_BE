-- Chi nhánh / kho Sapo: GET /admin/locations.json
CREATE TABLE "location_draft" (
    "id" UUID NOT NULL,
    "sapo_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "country" TEXT,
    "zip" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sapo_created_on" TIMESTAMP(3),
    "sapo_modified_on" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_draft_pkey" PRIMARY KEY ("id")
);

-- Tồn kho Sapo (màn Tồn kho): GET /admin/products.json + GET /admin/inventory_levels.json
CREATE TABLE "inventory_draft" (
    "id" UUID NOT NULL,
    "sapo_id" INTEGER NOT NULL,
    "sapo_variant_id" INTEGER NOT NULL,
    "sapo_inventory_item_id" INTEGER NOT NULL,
    "sapo_location_id" INTEGER NOT NULL,
    "sapo_store_id" INTEGER,
    "sapo_product_id" INTEGER,
    "product_name" TEXT,
    "variant_title" TEXT,
    "image_src" TEXT,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sku" TEXT,
    "barcode" TEXT,
    "on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "packed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "available" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "committed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "incoming" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "incoming_owned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "incoming_not_owned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unavailable" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sapo_created_at" TIMESTAMP(3),
    "sapo_updated_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_draft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "location_draft_sapo_id_key" ON "location_draft"("sapo_id");

CREATE INDEX "location_draft_active_name_idx" ON "location_draft"("active", "name");

CREATE UNIQUE INDEX "inventory_draft_sapo_id_key" ON "inventory_draft"("sapo_id");

CREATE UNIQUE INDEX "inventory_draft_sapo_variant_id_sapo_location_id_key" ON "inventory_draft"("sapo_variant_id", "sapo_location_id");

CREATE INDEX "inventory_draft_sku_idx" ON "inventory_draft"("sku");

CREATE INDEX "inventory_draft_sapo_location_id_idx" ON "inventory_draft"("sapo_location_id");

CREATE INDEX "inventory_draft_sapo_product_id_idx" ON "inventory_draft"("sapo_product_id");

ALTER TABLE "inventory_draft" ADD CONSTRAINT "inventory_draft_sapo_location_id_fkey" FOREIGN KEY ("sapo_location_id") REFERENCES "location_draft"("sapo_id") ON DELETE RESTRICT ON UPDATE CASCADE;
