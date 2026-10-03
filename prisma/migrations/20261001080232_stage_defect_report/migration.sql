-- AlterTable
ALTER TABLE "production_stage_entries" ADD COLUMN     "defect_note" TEXT,
ADD COLUMN     "defect_reported_at" TIMESTAMP(3),
ADD COLUMN     "defect_reported_by_name" TEXT,
ADD COLUMN     "defect_reported_by_user_id" UUID;
