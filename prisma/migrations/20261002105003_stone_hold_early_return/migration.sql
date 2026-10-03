-- AlterTable
ALTER TABLE "production_stone_holds" ADD COLUMN     "early_returned_count" INTEGER,
ADD COLUMN     "early_returned_qty" DECIMAL(18,4),
ADD COLUMN     "early_returned_weight" DECIMAL(18,4),
ALTER COLUMN "stone_count" DROP NOT NULL;

