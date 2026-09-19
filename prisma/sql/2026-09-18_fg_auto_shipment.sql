SET search_path TO enshido;

ALTER TABLE "production_orders"
  ADD COLUMN IF NOT EXISTS "source_order_code" TEXT;

ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "auto_issued" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "created_by_order_id" UUID;

CREATE INDEX IF NOT EXISTS "shipments_created_by_order_id_idx"
  ON "shipments" ("created_by_order_id");

DO $$
BEGIN
  ALTER TABLE "shipments"
    ADD CONSTRAINT "shipments_created_by_order_id_fkey"
    FOREIGN KEY ("created_by_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
