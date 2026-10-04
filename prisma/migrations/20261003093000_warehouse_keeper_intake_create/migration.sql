-- Thủ kho được tạo đơn: ai đang có warehouse.keeper nhận thêm intake.create (khớp vai trò Thủ kho
-- ở màn Nhân sự).
UPDATE "users" AS u
SET "allowed_screens" = ARRAY(
  SELECT DISTINCT x FROM unnest(u."allowed_screens" || ARRAY['intake.create']) AS x
)
WHERE 'warehouse.keeper' = ANY(u."allowed_screens")
  AND NOT ('intake.create' = ANY(u."allowed_screens"));
