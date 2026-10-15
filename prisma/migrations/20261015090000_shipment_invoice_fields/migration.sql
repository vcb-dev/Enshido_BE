-- AlterTable
ALTER TABLE "shipment_lines" ADD COLUMN     "labor_amount" DECIMAL(18,2),
ADD COLUMN     "material_unit_price" DECIMAL(18,2),
ADD COLUMN     "other_amount" DECIMAL(18,2),
ADD COLUMN     "stone_amount" DECIMAL(18,2),
ADD COLUMN     "weight_chi" DECIMAL(18,2);
