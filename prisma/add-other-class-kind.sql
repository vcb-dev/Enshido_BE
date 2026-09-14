DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OtherClassKind') THEN
    CREATE TYPE "OtherClassKind" AS ENUM ('CATALOG', 'OTHER');
  END IF;
END $$;

ALTER TABLE "other_classes"
  ADD COLUMN IF NOT EXISTS "kind" "OtherClassKind" NOT NULL DEFAULT 'CATALOG';

CREATE INDEX IF NOT EXISTS "other_classes_kind_sort_order_idx"
  ON "other_classes" ("kind", "sort_order");
