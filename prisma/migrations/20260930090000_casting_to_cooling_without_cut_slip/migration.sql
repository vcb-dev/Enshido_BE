ALTER TYPE "CastingSlipImageKind" ADD VALUE 'REST';
ALTER TYPE "ProductionImageKind" ADD VALUE 'CUT_BLANK';

ALTER TABLE "casting_slips" ADD COLUMN "rest_inbound_id" UUID,
ADD COLUMN "rest_material_id" UUID,
ADD COLUMN "rest_weight_gram" DECIMAL(18,4);

ALTER TABLE "production_orders" ADD COLUMN "blank_inbound_id" UUID,
ADD COLUMN "blank_material_id" UUID,
ADD COLUMN "blank_qty" INTEGER,
ADD COLUMN "blank_weight" DECIMAL(18,4);

CREATE UNIQUE INDEX "casting_slips_rest_inbound_id_key" ON "casting_slips"("rest_inbound_id");
CREATE UNIQUE INDEX "production_orders_blank_inbound_id_key" ON "production_orders"("blank_inbound_id");
