-- AlterTable
ALTER TABLE "production_sub_ticket_top_ups" ADD COLUMN     "material_id" UUID,
ADD COLUMN     "outbound_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "production_sub_ticket_top_ups_outbound_id_key" ON "production_sub_ticket_top_ups"("outbound_id");

-- CreateIndex
CREATE INDEX "production_sub_ticket_top_ups_material_id_idx" ON "production_sub_ticket_top_ups"("material_id");

-- AddForeignKey
ALTER TABLE "production_sub_ticket_top_ups" ADD CONSTRAINT "production_sub_ticket_top_ups_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_sub_ticket_top_ups" ADD CONSTRAINT "production_sub_ticket_top_ups_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "stock_outbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

