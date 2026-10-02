ALTER TABLE "casting_slips"
ADD COLUMN IF NOT EXISTS "assigned_user_id" UUID,
ADD COLUMN IF NOT EXISTS "assigned_user_name" TEXT;
