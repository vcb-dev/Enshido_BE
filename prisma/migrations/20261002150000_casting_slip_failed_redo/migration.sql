-- AlterEnum
ALTER TYPE "CastingSlipStatus" ADD VALUE IF NOT EXISTS 'CAST_FAILED';

-- AlterTable
ALTER TABLE "casting_slips" ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "rejected_by_name" TEXT,
ADD COLUMN IF NOT EXISTS "redo_of_slip_id" UUID;

CREATE INDEX IF NOT EXISTS "casting_slips_redo_of_slip_id_idx" ON "casting_slips"("redo_of_slip_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'casting_slips_redo_of_slip_id_fkey'
  ) THEN
    ALTER TABLE "casting_slips"
      ADD CONSTRAINT "casting_slips_redo_of_slip_id_fkey"
      FOREIGN KEY ("redo_of_slip_id") REFERENCES "casting_slips"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
