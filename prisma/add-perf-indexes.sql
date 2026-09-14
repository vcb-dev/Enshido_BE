-- Safe to re-run. Does not drop or alter columns.
CREATE INDEX IF NOT EXISTS "stock_inbounds_wh_mat_apply_idx"
  ON "stock_inbounds" ("warehouse_id", "material_id", "apply_to_stock");

CREATE INDEX IF NOT EXISTS "stock_inbounds_material_id_idx"
  ON "stock_inbounds" ("material_id");

CREATE INDEX IF NOT EXISTS "stock_outbounds_wh_mat_apply_idx"
  ON "stock_outbounds" ("warehouse_id", "material_id", "apply_to_stock");

CREATE INDEX IF NOT EXISTS "stock_outbounds_material_id_idx"
  ON "stock_outbounds" ("material_id");

CREATE INDEX IF NOT EXISTS "materials_warehouse_id_location_code_idx"
  ON "materials" ("warehouse_id", "location_code");

CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx"
  ON "refresh_tokens" ("expires_at");

CREATE INDEX IF NOT EXISTS "warehouse_locations_wh_slot_idx"
  ON "warehouse_locations" ("warehouse_id", "zone", "aisle", "level", "position");
