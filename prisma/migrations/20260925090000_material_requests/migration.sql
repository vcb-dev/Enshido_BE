-- CreateEnum
CREATE TYPE "MaterialRequestStatus" AS ENUM ('PENDING', 'ISSUED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaterialRequestKind" AS ENUM ('METAL', 'STONE', 'OTHER');

-- DropForeignKey
ALTER TABLE "production_sub_ticket_top_ups" DROP CONSTRAINT "production_sub_ticket_top_ups_material_id_fkey";

-- DropForeignKey
ALTER TABLE "production_sub_ticket_top_ups" DROP CONSTRAINT "production_sub_ticket_top_ups_outbound_id_fkey";

-- DropForeignKey
ALTER TABLE "production_sub_ticket_top_ups" DROP CONSTRAINT "production_sub_ticket_top_ups_stage_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "production_sub_ticket_top_ups" DROP CONSTRAINT "production_sub_ticket_top_ups_sub_ticket_id_fkey";

-- AlterTable
ALTER TABLE "production_orders" DROP COLUMN "silver_weight";

-- AlterTable
ALTER TABLE "production_stage_entries" ADD COLUMN     "returned_stone_count" INTEGER;

-- AlterTable
ALTER TABLE "production_sub_tickets" DROP COLUMN "silver_weight";

-- DropTable
DROP TABLE "production_sub_ticket_top_ups";

-- CreateTable
CREATE TABLE "production_material_requests" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sub_ticket_id" UUID,
    "stage_entry_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "status" "MaterialRequestStatus" NOT NULL DEFAULT 'PENDING',
    "kind" "MaterialRequestKind" NOT NULL,
    "requested_qty" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "requested_by_user_id" UUID,
    "requested_by_name" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_qty" DECIMAL(18,4),
    "issued_weight" DECIMAL(18,4),
    "issued_stone_count" INTEGER,
    "outbound_id" UUID,
    "handled_by_user_id" UUID,
    "handled_by_name" TEXT,
    "handled_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_material_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_material_requests_outbound_id_key" ON "production_material_requests"("outbound_id");

-- CreateIndex
CREATE INDEX "production_material_requests_order_id_created_at_idx" ON "production_material_requests"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "production_material_requests_sub_ticket_id_idx" ON "production_material_requests"("sub_ticket_id");

-- CreateIndex
CREATE INDEX "production_material_requests_stage_entry_id_idx" ON "production_material_requests"("stage_entry_id");

-- CreateIndex
CREATE INDEX "production_material_requests_status_requested_at_idx" ON "production_material_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "production_material_requests_material_id_idx" ON "production_material_requests"("material_id");

-- AddForeignKey
ALTER TABLE "production_material_requests" ADD CONSTRAINT "production_material_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material_requests" ADD CONSTRAINT "production_material_requests_sub_ticket_id_fkey" FOREIGN KEY ("sub_ticket_id") REFERENCES "production_sub_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material_requests" ADD CONSTRAINT "production_material_requests_stage_entry_id_fkey" FOREIGN KEY ("stage_entry_id") REFERENCES "production_stage_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material_requests" ADD CONSTRAINT "production_material_requests_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material_requests" ADD CONSTRAINT "production_material_requests_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "stock_outbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

