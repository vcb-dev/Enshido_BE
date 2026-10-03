-- AlterTable
ALTER TABLE "intake_orders" ADD COLUMN     "rework_of_entry_id" UUID,
ADD COLUMN     "rework_of_order_id" UUID,
ADD COLUMN     "rework_of_sub_ticket_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "intake_orders_rework_of_entry_id_key" ON "intake_orders"("rework_of_entry_id");

-- AddForeignKey
ALTER TABLE "intake_orders" ADD CONSTRAINT "intake_orders_rework_of_order_id_fkey" FOREIGN KEY ("rework_of_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

