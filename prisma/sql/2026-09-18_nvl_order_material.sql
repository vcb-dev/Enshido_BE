SET search_path TO enshido;

ALTER TABLE "production_orders"
  ADD COLUMN IF NOT EXISTS "nvl_material_id" UUID;

CREATE INDEX IF NOT EXISTS "production_orders_nvl_material_id_idx"
  ON "production_orders" ("nvl_material_id");

DO $$
BEGIN
  ALTER TABLE "production_orders"
    ADD CONSTRAINT "production_orders_nvl_material_id_fkey"
    FOREIGN KEY ("nvl_material_id") REFERENCES "materials"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
