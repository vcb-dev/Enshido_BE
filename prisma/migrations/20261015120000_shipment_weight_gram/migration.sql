-- TL tính tiền trên phiếu xuất đổi đơn vị từ chỉ sang gram (1 chỉ = 3,75 g).
ALTER TABLE "shipment_lines" RENAME COLUMN "weight_chi" TO "weight_gram";
UPDATE "shipment_lines" SET "weight_gram" = ROUND("weight_gram" * 3.75, 2) WHERE "weight_gram" IS NOT NULL;
