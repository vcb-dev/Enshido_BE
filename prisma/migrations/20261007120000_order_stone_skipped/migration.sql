-- AlterTable
ALTER TABLE "production_orders" ADD COLUMN     "stone_skipped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stone_skipped_at" TIMESTAMP(3),
ADD COLUMN     "stone_skipped_by_name" TEXT;
