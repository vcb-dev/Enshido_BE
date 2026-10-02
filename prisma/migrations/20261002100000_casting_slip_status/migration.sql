DO $$
BEGIN
    CREATE TYPE "CastingSlipStatus" AS ENUM ('WAIT_CASTING', 'CASTING', 'DONE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "casting_slips"
ADD COLUMN IF NOT EXISTS "status" "CastingSlipStatus" NOT NULL DEFAULT 'WAIT_CASTING';

CREATE INDEX IF NOT EXISTS "casting_slips_status_idx" ON "casting_slips"("status");
