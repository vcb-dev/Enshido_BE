-- Ảnh làm chứng KCS chụp lúc nhận lại khâu (Nguội → Xi).
-- CreateTable
CREATE TABLE "production_stage_images" (
    "id" UUID NOT NULL,
    "stage_entry_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_stage_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_stage_images_stage_entry_id_sort_order_idx" ON "production_stage_images"("stage_entry_id", "sort_order");

-- AddForeignKey
ALTER TABLE "production_stage_images" ADD CONSTRAINT "production_stage_images_stage_entry_id_fkey" FOREIGN KEY ("stage_entry_id") REFERENCES "production_stage_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
