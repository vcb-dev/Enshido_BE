-- Trạng thái Q Chờ đánh bóng, S Chờ xi, U Đã xi xong (mô tả luồng bước 20–22) — tách migration
-- riêng vì PostgreSQL không cho dùng giá trị enum mới ngay trong transaction vừa thêm nó.
ALTER TYPE "ProductionStatus" ADD VALUE 'WAIT_POLISHING';
ALTER TYPE "ProductionStatus" ADD VALUE 'WAIT_PLATING';
ALTER TYPE "ProductionStatus" ADD VALUE 'PLATED';
