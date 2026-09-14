-- Giai đoạn 2: gắn phiếu xuất NVL với đơn, tiền công khâu, chi phí khác, kho thành phẩm, phiếu xuất hàng.
-- Chạy SAU file 2026-09-14b_production_ticket.sql. Chỉ thêm cột / bảng mới, không sửa dữ liệu cũ.
-- Áp lên DB (trong thư mục Enshido_BE): npx prisma db execute --file prisma/sql/2026-09-14c_production_phase2.sql --schema prisma/schema.prisma

BEGIN;

-- AlterTable
ALTER TABLE "stock_outbounds" ADD COLUMN     "production_order_id" UUID;

-- AlterTable
ALTER TABLE "production_stage_entries" ADD COLUMN     "labor_cost" DECIMAL(18,2);

-- CreateTable
CREATE TABLE "production_order_costs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_order_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_receipts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "received_by_user_id" UUID,
    "received_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finished_goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "shipped_at" DATE NOT NULL,
    "customer_name" TEXT NOT NULL,
    "payment_method" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "last_printed_at" TIMESTAMP(3),
    "data_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_lines" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "unit_cost" DECIMAL(18,2) NOT NULL,
    "cost_amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_order_costs_order_id_created_at_idx" ON "production_order_costs"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_receipts_order_id_key" ON "finished_goods_receipts"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_seq_key" ON "shipments"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_code_key" ON "shipments"("code");

-- CreateIndex
CREATE INDEX "shipments_shipped_at_idx" ON "shipments"("shipped_at");

-- CreateIndex
CREATE INDEX "shipment_lines_shipment_id_sort_order_idx" ON "shipment_lines"("shipment_id", "sort_order");

-- CreateIndex
CREATE INDEX "shipment_lines_order_id_idx" ON "shipment_lines"("order_id");

-- AddForeignKey
ALTER TABLE "stock_outbounds" ADD CONSTRAINT "stock_outbounds_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_costs" ADD CONSTRAINT "production_order_costs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
