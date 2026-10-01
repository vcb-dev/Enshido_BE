-- AlterTable
ALTER TABLE "intake_orders" ADD COLUMN     "stone_count_3d" INTEGER,
ADD COLUMN     "stone_weight_3d_gram" DECIMAL(18,4);

-- CreateTable
CREATE TABLE "production_stone_holds" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sub_ticket_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "stone_count" INTEGER NOT NULL,
    "weight" DECIMAL(18,4),
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "stage_entry_id" UUID,
    "outbound_id" UUID,
    "used_count" INTEGER,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_stone_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_stone_holds_material_id_status_idx" ON "production_stone_holds"("material_id", "status");

-- CreateIndex
CREATE INDEX "production_stone_holds_sub_ticket_id_status_idx" ON "production_stone_holds"("sub_ticket_id", "status");

-- AddForeignKey
ALTER TABLE "production_stone_holds" ADD CONSTRAINT "production_stone_holds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stone_holds" ADD CONSTRAINT "production_stone_holds_sub_ticket_id_fkey" FOREIGN KEY ("sub_ticket_id") REFERENCES "production_sub_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
