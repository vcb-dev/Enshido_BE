-- Gộp quản lý SX (intake.approve) + thủ kho (warehouse.keeper) + KCS (production.qc) thành một
-- quyền "Quản lý xưởng" (production.manager). Ai đang có ít nhất một trong ba thì nhận quyền gộp;
-- ba mã cũ bỏ khỏi danh sách tick (BE tự mở rộng production.manager thành đủ các việc).
UPDATE "users" AS u
SET "allowed_screens" = ARRAY(
  SELECT DISTINCT x
  FROM unnest(u."allowed_screens" || ARRAY['production.manager']) AS x
  WHERE x NOT IN ('intake.approve', 'warehouse.keeper', 'production.qc')
)
WHERE u."allowed_screens" && ARRAY['intake.approve', 'warehouse.keeper', 'production.qc'];
