-- Global unique SKU. PostgreSQL still allows multiple NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS "materials_sku_key"
  ON "materials" ("sku");
