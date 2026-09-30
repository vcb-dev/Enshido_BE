-- Phiếu đúc = một lần đúc gồm nhiều đơn (bước 7 trong mô tả luồng), thay cho một phiếu gắn một đơn.

-- CreateTable
CREATE TABLE "casting_slip_orders" (
    "id" UUID NOT NULL,
    "slip_id" UUID NOT NULL,
    "intake_order_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "wax_weight_gram" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "casting_slip_orders_pkey" PRIMARY KEY ("id")
);

-- Chuyển liên kết cũ sang bảng mới. Trước đây một đơn có thể nằm trên nhiều phiếu (mỗi cối một
-- phiếu); bảng mới cho mỗi đơn đúng một phiếu nên giữ phiếu tạo sớm nhất của đơn.
INSERT INTO "casting_slip_orders" ("id", "slip_id", "intake_order_id", "sort_order", "wax_weight_gram")
SELECT DISTINCT ON (s."intake_order_id")
  gen_random_uuid(), s."id", s."intake_order_id", 0, s."wax_weight_gram"
FROM "casting_slips" s
ORDER BY s."intake_order_id", s."created_at";

-- DropForeignKey
ALTER TABLE "casting_slips" DROP CONSTRAINT "casting_slips_intake_order_id_fkey";

-- DropIndex
DROP INDEX "casting_slips_intake_order_id_idx";

-- AlterTable
ALTER TABLE "casting_slips" DROP COLUMN "intake_order_id",
ADD COLUMN     "created_by_name" TEXT,
ADD COLUMN     "last_printed_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "casting_slip_orders_intake_order_id_key" ON "casting_slip_orders"("intake_order_id");

-- CreateIndex
CREATE INDEX "casting_slip_orders_slip_id_sort_order_idx" ON "casting_slip_orders"("slip_id", "sort_order");

-- CreateIndex
CREATE INDEX "casting_slips_status_idx" ON "casting_slips"("status");

-- AddForeignKey
ALTER TABLE "casting_slip_orders" ADD CONSTRAINT "casting_slip_orders_slip_id_fkey" FOREIGN KEY ("slip_id") REFERENCES "casting_slips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_slip_orders" ADD CONSTRAINT "casting_slip_orders_intake_order_id_fkey" FOREIGN KEY ("intake_order_id") REFERENCES "intake_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
