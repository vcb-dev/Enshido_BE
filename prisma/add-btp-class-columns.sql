ALTER TABLE "materials"
  ADD COLUMN IF NOT EXISTS "body_metal_id" UUID,
  ADD COLUMN IF NOT EXISTS "product_kind_id" UUID;

CREATE INDEX IF NOT EXISTS "materials_body_metal_id_idx" ON "materials" ("body_metal_id");
CREATE INDEX IF NOT EXISTS "materials_product_kind_id_idx" ON "materials" ("product_kind_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'materials_body_metal_id_fkey'
  ) THEN
    ALTER TABLE "materials"
      ADD CONSTRAINT "materials_body_metal_id_fkey"
      FOREIGN KEY ("body_metal_id") REFERENCES "other_classes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'materials_product_kind_id_fkey'
  ) THEN
    ALTER TABLE "materials"
      ADD CONSTRAINT "materials_product_kind_id_fkey"
      FOREIGN KEY ("product_kind_id") REFERENCES "other_classes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "other_classes" ("id", "code", "name", "kind", "parent_id", "sort_order", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'chat-lieu', 'Chất liệu', 'CATALOG', NULL, 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'phan-loai-san-pham', 'Phân loại sản phẩm', 'CATALOG', NULL, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "sort_order" = EXCLUDED."sort_order",
    "parent_id" = NULL;

INSERT INTO "other_classes" ("id", "code", "name", "kind", "parent_id", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), v.code, v.name, 'CATALOG', p.id, v.sort_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  VALUES
    ('chat-lieu-bac', 'Bạc', 1),
    ('chat-lieu-vang', 'Vàng', 2),
    ('chat-lieu-hoi-pha', 'Hội pha', 3),
    ('chat-lieu-dong', 'Đồng', 4)
) AS v(code, name, sort_order)
JOIN "other_classes" p ON p.code = 'chat-lieu'
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "sort_order" = EXCLUDED."sort_order",
    "parent_id" = EXCLUDED."parent_id";

INSERT INTO "other_classes" ("id", "code", "name", "kind", "parent_id", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), v.code, v.name, 'CATALOG', p.id, v.sort_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  VALUES
    ('sp-nhan', 'Nhẫn', 1),
    ('sp-day-chuyen', 'Dây chuyền', 2),
    ('sp-lac-tay', 'Lắc tay', 3),
    ('sp-lac-chan', 'Lắc chân', 4),
    ('sp-bong-tai', 'Bông tai', 5),
    ('sp-mat-day', 'Mặt dây', 6),
    ('sp-charm', 'Charm', 7),
    ('sp-bo', 'Bộ trang sức', 8),
    ('sp-khac', 'Khác', 9)
) AS v(code, name, sort_order)
JOIN "other_classes" p ON p.code = 'phan-loai-san-pham'
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "sort_order" = EXCLUDED."sort_order",
    "parent_id" = EXCLUDED."parent_id";
