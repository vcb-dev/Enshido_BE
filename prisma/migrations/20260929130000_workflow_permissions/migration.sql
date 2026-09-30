-- Quyền theo việc (intake.create/approve, production.model3d/wax/cast/qc, warehouse.keeper).
-- Giữ nguyên khả năng làm việc của nhân viên hiện có để không ai mất quyền đột ngột:
--   * mọi Nhân viên (USER) được cấp các quyền việc trừ thủ kho;
--   * warehouse.keeper chỉ cấp cho người đang có ít nhất một màn kho (trước đây chính họ là thủ kho xác nhận).
-- Admin xem hết, Thợ (WORKER) không được cấp — sau đó admin thu hẹp ở màn Nhân sự.
UPDATE "users" AS u
SET "allowed_screens" = ARRAY(
  SELECT DISTINCT x
  FROM unnest(
    u."allowed_screens"
    || ARRAY['intake.create', 'intake.approve', 'production.model3d', 'production.wax', 'production.cast', 'production.qc']
    || CASE
         WHEN EXISTS (
           SELECT 1 FROM unnest(u."allowed_screens") AS s WHERE s LIKE 'screen.warehouse.%'
         ) THEN ARRAY['warehouse.keeper']
         ELSE ARRAY[]::text[]
       END
  ) AS x
)
WHERE u."role_code" = 'USER';
