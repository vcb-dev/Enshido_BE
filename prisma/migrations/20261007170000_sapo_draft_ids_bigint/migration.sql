ALTER TABLE "inventory_draft" DROP CONSTRAINT "inventory_draft_sapo_location_id_fkey";

ALTER TABLE "location_draft" ALTER COLUMN "sapo_id" SET DATA TYPE BIGINT;

ALTER TABLE "inventory_draft" ALTER COLUMN "sapo_id" SET DATA TYPE BIGINT;
ALTER TABLE "inventory_draft" ALTER COLUMN "sapo_variant_id" SET DATA TYPE BIGINT;
ALTER TABLE "inventory_draft" ALTER COLUMN "sapo_inventory_item_id" SET DATA TYPE BIGINT;
ALTER TABLE "inventory_draft" ALTER COLUMN "sapo_location_id" SET DATA TYPE BIGINT;
ALTER TABLE "inventory_draft" ALTER COLUMN "sapo_store_id" SET DATA TYPE BIGINT;
ALTER TABLE "inventory_draft" ALTER COLUMN "sapo_product_id" SET DATA TYPE BIGINT;

ALTER TABLE "inventory_draft" ADD CONSTRAINT "inventory_draft_sapo_location_id_fkey" FOREIGN KEY ("sapo_location_id") REFERENCES "location_draft"("sapo_id") ON DELETE RESTRICT ON UPDATE CASCADE;
