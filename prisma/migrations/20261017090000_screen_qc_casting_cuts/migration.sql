-- Phiếu QC, Cắt cây thông, Lệnh đúc thành quyền màn hình tích được ở màn Nhân sự.
-- Trước đây menu tự hiện theo vai trò; thêm quyền mới cho đúng các tài khoản đang thấy menu
-- để không ai mất màn đang dùng. Chỉ sửa dữ liệu, không đổi cấu trúc bảng.

-- QC (production.qc) đang thấy Phiếu QC.
UPDATE "users"
SET "allowed_screens" = array_append("allowed_screens", 'screen.qc-tickets')
WHERE 'production.qc' = ANY("allowed_screens")
  AND NOT ('screen.qc-tickets' = ANY("allowed_screens"));

-- Thủ kho (warehouse.keeper) đang thấy Cắt cây thông.
UPDATE "users"
SET "allowed_screens" = array_append("allowed_screens", 'screen.casting-cuts')
WHERE 'warehouse.keeper' = ANY("allowed_screens")
  AND NOT ('screen.casting-cuts' = ANY("allowed_screens"));

-- Luật cũ: nhân viên văn phòng (USER có Tổng quan, không phải thủ kho / thợ / khách) tự thấy Lệnh đúc.
UPDATE "users"
SET "allowed_screens" = array_append("allowed_screens", 'screen.casting-orders')
WHERE ("role_code" = 'USER' OR 'USER' = ANY("extra_roles"))
  AND NOT ('ADMIN' = ANY("extra_roles"))
  AND NOT ('WORKER' = ANY("extra_roles"))
  AND 'screen.dashboard' = ANY("allowed_screens")
  AND NOT ('warehouse.keeper' = ANY("allowed_screens"))
  AND NOT ('customer' = ANY("allowed_screens"))
  AND NOT ('screen.casting-orders' = ANY("allowed_screens"));
