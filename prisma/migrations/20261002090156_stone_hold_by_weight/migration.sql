-- AlterTable
ALTER TABLE "production_stone_holds" ADD COLUMN     "request_id" UUID,
ADD COLUMN     "returned_count" INTEGER,
ADD COLUMN     "returned_weight" DECIMAL(18,4);

-- CreateIndex
CREATE UNIQUE INDEX "production_stone_holds_request_id_key" ON "production_stone_holds"("request_id");

-- AddForeignKey
ALTER TABLE "production_stone_holds" ADD CONSTRAINT "production_stone_holds_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "production_material_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

