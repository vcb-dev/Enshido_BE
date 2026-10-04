-- Trạng thái tiền-Nguội của đơn tạo — tách migration riêng vì PostgreSQL không cho dùng giá trị enum
-- mới ngay trong transaction vừa thêm nó (migration sau backfill dùng các giá trị này).
ALTER TYPE "ProductionStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "ProductionStatus" ADD VALUE 'REJECTED';
ALTER TYPE "ProductionStatus" ADD VALUE 'APPROVED';
ALTER TYPE "ProductionStatus" ADD VALUE 'READY_FOR_PRODUCTION';
ALTER TYPE "ProductionStatus" ADD VALUE 'WAX_PRINTED';
ALTER TYPE "ProductionStatus" ADD VALUE 'PENDING_WAREHOUSE_CONFIRMATION';
ALTER TYPE "ProductionStatus" ADD VALUE 'WAX_CONFIRMED';
ALTER TYPE "ProductionStatus" ADD VALUE 'WAIT_CASTING';
ALTER TYPE "ProductionStatus" ADD VALUE 'CAST_PENDING_CONFIRMATION';
ALTER TYPE "ProductionStatus" ADD VALUE 'CAST_DONE';
