CREATE TABLE IF NOT EXISTS "other_classes" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "other_classes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "other_classes_code_key" ON "other_classes" ("code");
CREATE INDEX IF NOT EXISTS "other_classes_sort_order_idx" ON "other_classes" ("sort_order");

ALTER TABLE "materials"
  ADD COLUMN IF NOT EXISTS "other_class_id" UUID;

CREATE INDEX IF NOT EXISTS "materials_other_class_id_idx" ON "materials" ("other_class_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'materials_other_class_id_fkey'
  ) THEN
    ALTER TABLE "materials"
      ADD CONSTRAINT "materials_other_class_id_fkey"
      FOREIGN KEY ("other_class_id") REFERENCES "other_classes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
