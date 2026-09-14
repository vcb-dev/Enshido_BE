ALTER TABLE "material_types"
  ADD COLUMN IF NOT EXISTS "metal_kind" "MetalKind";

CREATE INDEX IF NOT EXISTS "material_types_metal_kind_sort_order_idx"
  ON "material_types" ("metal_kind", "sort_order");
