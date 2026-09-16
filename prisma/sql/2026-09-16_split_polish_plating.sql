-- Tách "Bóng xi" thành hai khâu / hai trạng thái riêng: Bóng (POLISHING) và Xi (PLATING).
-- Dữ liệu cũ POLISH_PLATING đổi hết sang POLISHING (khâu đánh bóng), Xi là khâu mới nằm ngay sau.
-- Chạy SAU file 2026-09-14d_order_source_btp.sql.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-16_split_polish_plating.sql --schema prisma/schema.prisma

BEGIN;

-- AlterEnum: ProductionStage (cột "Quá trình sản xuất" trên phiếu thợ)
ALTER TYPE "ProductionStage" RENAME TO "ProductionStage_old";

CREATE TYPE "ProductionStage" AS ENUM ('FILING', 'STONE_SETTING', 'POLISHING', 'PLATING', 'ENGRAVING', 'APPEARANCE');

ALTER TABLE "production_stage_entries"
  ALTER COLUMN "stage" TYPE "ProductionStage"
  USING (CASE WHEN "stage"::text = 'POLISH_PLATING' THEN 'POLISHING' ELSE "stage"::text END)::"ProductionStage";

DROP TYPE "ProductionStage_old";

-- AlterEnum: ProductionStatus (trạng thái đơn)
ALTER TYPE "ProductionStatus" RENAME TO "ProductionStatus_old";

CREATE TYPE "ProductionStatus" AS ENUM ('NEW', 'REDO_3D', 'CASTING', 'FILING', 'STONE_SETTING', 'POLISHING', 'PLATING', 'FINISHING', 'DELIVERED', 'DEFECT');

ALTER TABLE "production_orders" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "production_orders"
  ALTER COLUMN "status" TYPE "ProductionStatus"
  USING (CASE WHEN "status"::text = 'POLISH_PLATING' THEN 'POLISHING' ELSE "status"::text END)::"ProductionStatus";

ALTER TABLE "production_orders" ALTER COLUMN "status" SET DEFAULT 'NEW';

ALTER TABLE "production_status_logs"
  ALTER COLUMN "from_status" TYPE "ProductionStatus"
  USING (CASE WHEN "from_status"::text = 'POLISH_PLATING' THEN 'POLISHING' ELSE "from_status"::text END)::"ProductionStatus";

ALTER TABLE "production_status_logs"
  ALTER COLUMN "to_status" TYPE "ProductionStatus"
  USING (CASE WHEN "to_status"::text = 'POLISH_PLATING' THEN 'POLISHING' ELSE "to_status"::text END)::"ProductionStatus";

DROP TYPE "ProductionStatus_old";

COMMIT;
