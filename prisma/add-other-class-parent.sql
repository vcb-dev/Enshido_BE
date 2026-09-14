ALTER TABLE "other_classes"
  ADD COLUMN IF NOT EXISTS "parent_id" UUID;

CREATE INDEX IF NOT EXISTS "other_classes_parent_id_idx" ON "other_classes" ("parent_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'other_classes_parent_id_fkey'
  ) THEN
    ALTER TABLE "other_classes"
      ADD CONSTRAINT "other_classes_parent_id_fkey"
      FOREIGN KEY ("parent_id") REFERENCES "other_classes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
