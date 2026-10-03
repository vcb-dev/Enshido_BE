-- Bỏ quyền "Quản lý xưởng" (production.manager): xưởng chỉ có thủ kho, KCS và các loại thợ.
-- Migration 20260929170000 đã gộp intake.approve / warehouse.keeper / production.qc của người
-- đang dùng thành production.manager — trả lại đúng các quyền mà nó bao gồm để không ai mất
-- việc đang làm; admin chọn lại vai trò (Thủ kho / KCS) ở màn Nhân sự.
UPDATE "users" AS u
SET "allowed_screens" = ARRAY(
  SELECT DISTINCT x
  FROM unnest(
    u."allowed_screens"
    || ARRAY['intake.create', 'intake.approve', 'warehouse.keeper', 'production.qc']
  ) AS x
  WHERE x <> 'production.manager'
)
WHERE 'production.manager' = ANY(u."allowed_screens");
