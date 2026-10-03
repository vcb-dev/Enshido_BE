-- AddForeignKey
ALTER TABLE "production_stone_holds" ADD CONSTRAINT "production_stone_holds_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

