-- Đơn sản xuất (giai đoạn 1): chỉ tạo enum + bảng mới, không sửa bảng cũ.
-- Áp lên DB: npx prisma db execute --file prisma/sql/2026-09-14_production_orders.sql --schema prisma/schema.prisma
-- (lệnh dùng DIRECT_URL/DATABASE_URL trong .env). Sinh bằng prisma migrate diff từ schema trước/sau.

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('NEW', 'REDO_3D', 'CASTING', 'FILING', 'STONE_SETTING', 'POLISH_PLATING', 'FINISHING', 'DELIVERED', 'DEFECT');

-- CreateEnum
CREATE TYPE "ProductionRequestType" AS ENUM ('SAMPLE', 'RETAIL', 'BULK');

-- CreateEnum
CREATE TYPE "ProductionImageKind" AS ENUM ('DETAIL', 'PRODUCT');

-- CreateEnum
CREATE TYPE "KcsResult" AS ENUM ('PASS', 'FAIL');

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ProductionStatus" NOT NULL DEFAULT 'NEW',
    "request_type" "ProductionRequestType" NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "model_3d_code" TEXT,
    "model_3d_url" TEXT,
    "lead_time" TEXT,
    "tracking_code" TEXT,
    "closed_by" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "stone_color" TEXT,
    "stone_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "size" TEXT,
    "main_material" TEXT,
    "plating_color" TEXT,
    "asked_user_id" UUID,
    "asked_user_name" TEXT,
    "received_date" DATE NOT NULL,
    "debt_status" TEXT,
    "parent_id" UUID,
    "kcs_result" "KcsResult",
    "kcs_note" TEXT,
    "kcs_by_user_id" UUID,
    "kcs_by_name" TEXT,
    "kcs_at" TIMESTAMP(3),
    "last_printed_at" TIMESTAMP(3),
    "data_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order_images" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" "ProductionImageKind" NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_order_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage_entries" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "stage" "ProductionStatus" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "craftsman_user_id" UUID,
    "craftsman_name" TEXT NOT NULL,
    "received_at" TIMESTAMP(3),
    "handed_over_at" TIMESTAMP(3),
    "weight_in" DECIMAL(18,4),
    "weight_out" DECIMAL(18,4),
    "note" TEXT,
    "confirmed_by_user_id" UUID,
    "confirmed_by_name" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_stage_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_status_logs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "ProductionStatus",
    "to_status" "ProductionStatus" NOT NULL,
    "note" TEXT,
    "changed_by" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_seq_key" ON "production_orders"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_code_key" ON "production_orders"("code");

-- CreateIndex
CREATE INDEX "production_orders_status_created_at_idx" ON "production_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "production_orders_request_type_idx" ON "production_orders"("request_type");

-- CreateIndex
CREATE INDEX "production_orders_parent_id_idx" ON "production_orders"("parent_id");

-- CreateIndex
CREATE INDEX "production_order_images_order_id_kind_sort_order_idx" ON "production_order_images"("order_id", "kind", "sort_order");

-- CreateIndex
CREATE INDEX "production_stage_entries_order_id_created_at_idx" ON "production_stage_entries"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "production_stage_entries_order_id_stage_attempt_key" ON "production_stage_entries"("order_id", "stage", "attempt");

-- CreateIndex
CREATE INDEX "production_status_logs_order_id_changed_at_idx" ON "production_status_logs"("order_id", "changed_at");

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_images" ADD CONSTRAINT "production_order_images_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_entries" ADD CONSTRAINT "production_stage_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_status_logs" ADD CONSTRAINT "production_status_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

