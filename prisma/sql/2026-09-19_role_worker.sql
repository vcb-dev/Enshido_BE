-- Role "Thợ" (WORKER) cho thợ sản xuất: đăng nhập vào là thấy thẳng phiếu con của mình,
-- không vào được màn quản lý đơn sản xuất. Role tự cấp quyền production.worker
-- (xem src/auth/permissions.ts ROLE_PERMISSIONS) nên không phải tick tay quyền màn hình.
-- Chạy SAU file 2026-09-18_sub_ticket_outcome.sql.
-- KHÔNG gán role cho tài khoản nào — đổi role là việc của con người, làm ở màn Nhân sự.
-- KHÔNG bọc BEGIN/COMMIT: giá trị enum mới không dùng được trong chính transaction tạo ra nó,
-- nên để chạy ngoài transaction cho an toàn với mọi phiên bản Postgres.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-19_role_worker.sql --schema prisma/schema.prisma

-- AlterEnum
ALTER TYPE "RoleCode" ADD VALUE IF NOT EXISTS 'WORKER';
