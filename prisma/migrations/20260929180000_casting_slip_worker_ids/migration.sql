-- AlterTable
ALTER TABLE "casting_slips" ADD COLUMN     "started_by_user_id" UUID,
ADD COLUMN     "submitted_by_user_id" UUID;

-- CreateIndex
CREATE INDEX "casting_slips_started_by_user_id_idx" ON "casting_slips"("started_by_user_id");


-- Phiếu cũ chỉ có tên: nối tên người bấm với tài khoản để hao hụt tính đúng thợ.
UPDATE "casting_slips" s SET "started_by_user_id" = u."id"
FROM "users" u WHERE s."started_by_user_id" IS NULL AND s."started_by_name" = u."full_name";
UPDATE "casting_slips" s SET "submitted_by_user_id" = u."id"
FROM "users" u WHERE s."submitted_by_user_id" IS NULL AND s."submitted_by_name" = u."full_name";
