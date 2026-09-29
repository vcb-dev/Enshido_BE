-- CreateEnum
CREATE TYPE "IntakeOrderStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "intake_orders" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "status" "IntakeOrderStatus" NOT NULL DEFAULT 'NEW',
    "request_type" "ProductionRequestType" NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "tracking_code" TEXT,
    "placed_by" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_date" DATE NOT NULL,
    "due_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intake_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_order_images" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" "ProductionImageKind" NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "intake_order_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "intake_orders_seq_key" ON "intake_orders"("seq");
CREATE UNIQUE INDEX "intake_orders_code_key" ON "intake_orders"("code");
CREATE INDEX "intake_orders_status_created_date_idx" ON "intake_orders"("status", "created_date");
CREATE INDEX "intake_orders_tracking_code_idx" ON "intake_orders"("tracking_code");
CREATE INDEX "intake_orders_placed_by_idx" ON "intake_orders"("placed_by");
CREATE INDEX "intake_orders_request_type_idx" ON "intake_orders"("request_type");
CREATE INDEX "intake_order_images_order_id_kind_sort_order_idx" ON "intake_order_images"("order_id", "kind", "sort_order");

-- AddForeignKey
ALTER TABLE "intake_order_images" ADD CONSTRAINT "intake_order_images_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "intake_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
