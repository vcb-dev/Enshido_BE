ALTER TABLE "stock_outbounds"
  ADD COLUMN IF NOT EXISTS "dest_warehouse_id" UUID,
  ADD COLUMN IF NOT EXISTS "dest_inbound_id" UUID;

ALTER TABLE "stock_inbounds"
  ADD COLUMN IF NOT EXISTS "source_warehouse_id" UUID,
  ADD COLUMN IF NOT EXISTS "source_outbound_id" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "stock_outbounds_dest_inbound_id_key"
  ON "stock_outbounds" ("dest_inbound_id");

CREATE UNIQUE INDEX IF NOT EXISTS "stock_inbounds_source_outbound_id_key"
  ON "stock_inbounds" ("source_outbound_id");
