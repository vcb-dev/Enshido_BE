INSERT INTO "other_classes" ("id", "code", "name", "kind", "parent_id", "sort_order", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'danh-muc-btp', 'Danh mục BTP', 'OTHER', NULL, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "kind" = 'OTHER',
    "sort_order" = EXCLUDED."sort_order",
    "parent_id" = NULL;

UPDATE "other_classes"
SET "kind" = 'OTHER',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" IN ('chat-lieu', 'phan-loai-san-pham', 'danh-muc-btp');

UPDATE "other_classes" AS child
SET "kind" = 'OTHER',
    "updated_at" = CURRENT_TIMESTAMP
FROM "other_classes" AS parent
WHERE child."parent_id" = parent."id"
  AND parent."code" IN ('chat-lieu', 'phan-loai-san-pham', 'danh-muc-btp');

INSERT INTO "other_classes" ("id", "code", "name", "kind", "parent_id", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), v.code, v.name, 'OTHER', p.id, v.sort_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  VALUES
    ('btp-da', 'Đá', 1),
    ('btp-si-bong', 'Si bóng', 2)
) AS v(code, name, sort_order)
JOIN "other_classes" p ON p.code = 'danh-muc-btp'
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "kind" = 'OTHER',
    "sort_order" = EXCLUDED."sort_order",
    "parent_id" = EXCLUDED."parent_id";
