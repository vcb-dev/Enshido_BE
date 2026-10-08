-- Ảnh làm chứng thủ kho chụp lúc cấp gói đá cho khâu Vào đá.
-- CreateTable
CREATE TABLE "production_stone_hold_images" (
    "id" UUID NOT NULL,
    "hold_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_stone_hold_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_stone_hold_images_hold_id_sort_order_idx" ON "production_stone_hold_images"("hold_id", "sort_order");

-- AddForeignKey
ALTER TABLE "production_stone_hold_images" ADD CONSTRAINT "production_stone_hold_images_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "production_stone_holds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
