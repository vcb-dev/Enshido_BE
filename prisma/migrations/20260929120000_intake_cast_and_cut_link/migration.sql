-- CreateEnum
CREATE TYPE "CastingSlipStatus" AS ENUM ('WAIT_CASTING', 'CASTING', 'PENDING_CONFIRMATION', 'DONE');

-- CreateEnum
CREATE TYPE "CastingSlipImageKind" AS ENUM ('ISSUE', 'RESULT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntakeOrderStatus" ADD VALUE 'CASTING';
ALTER TYPE "IntakeOrderStatus" ADD VALUE 'CAST_DONE';
ALTER TYPE "IntakeOrderStatus" ADD VALUE 'WAIT_COOLING';

-- AlterTable
ALTER TABLE "casting_slip_images" ADD COLUMN     "kind" "CastingSlipImageKind" NOT NULL DEFAULT 'ISSUE';

-- AlterTable
ALTER TABLE "casting_slips" ADD COLUMN     "cast_tree_weight_gram" DECIMAL(18,4),
ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_by_name" TEXT,
ADD COLUMN     "plaster_used_gram" DECIMAL(18,4),
ADD COLUMN     "silver_used_gram" DECIMAL(18,4),
ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "started_by_name" TEXT,
ADD COLUMN     "status" "CastingSlipStatus" NOT NULL DEFAULT 'WAIT_CASTING',
ADD COLUMN     "submitted_at" TIMESTAMP(3),
ADD COLUMN     "submitted_by_name" TEXT;

-- AlterTable
ALTER TABLE "production_orders" ADD COLUMN     "intake_order_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_intake_order_id_key" ON "production_orders"("intake_order_id");

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_intake_order_id_fkey" FOREIGN KEY ("intake_order_id") REFERENCES "intake_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

