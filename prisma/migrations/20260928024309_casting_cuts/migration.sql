-- AlterTable
ALTER TABLE "production_orders" ADD COLUMN     "cut_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stock_inbounds" ADD COLUMN     "auto_issued" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gram_qty" DECIMAL(18,4),
ADD COLUMN     "production_order_id" UUID;

-- CreateTable
CREATE TABLE "casting_cuts" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "casting_order_id" UUID,
    "cut_at" TIMESTAMP(3) NOT NULL,
    "tree_weight" DECIMAL(18,4) NOT NULL,
    "rest_weight" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "rest_material_id" UUID,
    "rest_inbound_id" UUID,
    "note" TEXT,
    "cut_by_user_id" UUID,
    "cut_by_name" TEXT NOT NULL,
    "last_printed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casting_cuts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_cut_lines" (
    "id" UUID NOT NULL,
    "cut_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "qty" INTEGER NOT NULL,
    "weight" DECIMAL(18,4) NOT NULL,
    "btp_material_id" UUID NOT NULL,
    "btp_inbound_id" UUID,
    "prev_status" "ProductionStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "casting_cut_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_cut_images" (
    "id" UUID NOT NULL,
    "cut_id" UUID NOT NULL,
    "line_id" UUID,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "casting_cut_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "casting_cuts_seq_key" ON "casting_cuts"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "casting_cuts_code_key" ON "casting_cuts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "casting_cuts_rest_inbound_id_key" ON "casting_cuts"("rest_inbound_id");

-- CreateIndex
CREATE INDEX "casting_cuts_cut_at_idx" ON "casting_cuts"("cut_at");

-- CreateIndex
CREATE INDEX "casting_cuts_casting_order_id_idx" ON "casting_cuts"("casting_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "casting_cut_lines_btp_inbound_id_key" ON "casting_cut_lines"("btp_inbound_id");

-- CreateIndex
CREATE INDEX "casting_cut_lines_order_id_idx" ON "casting_cut_lines"("order_id");

-- CreateIndex
CREATE INDEX "casting_cut_lines_cut_id_sort_order_idx" ON "casting_cut_lines"("cut_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "casting_cut_lines_cut_id_order_id_key" ON "casting_cut_lines"("cut_id", "order_id");

-- CreateIndex
CREATE INDEX "casting_cut_images_cut_id_line_id_sort_order_idx" ON "casting_cut_images"("cut_id", "line_id", "sort_order");

-- CreateIndex
CREATE INDEX "stock_inbounds_production_order_id_idx" ON "stock_inbounds"("production_order_id");

-- AddForeignKey
ALTER TABLE "stock_inbounds" ADD CONSTRAINT "stock_inbounds_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cuts" ADD CONSTRAINT "casting_cuts_casting_order_id_fkey" FOREIGN KEY ("casting_order_id") REFERENCES "casting_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cuts" ADD CONSTRAINT "casting_cuts_rest_material_id_fkey" FOREIGN KEY ("rest_material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cuts" ADD CONSTRAINT "casting_cuts_rest_inbound_id_fkey" FOREIGN KEY ("rest_inbound_id") REFERENCES "stock_inbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cut_lines" ADD CONSTRAINT "casting_cut_lines_cut_id_fkey" FOREIGN KEY ("cut_id") REFERENCES "casting_cuts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cut_lines" ADD CONSTRAINT "casting_cut_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cut_lines" ADD CONSTRAINT "casting_cut_lines_btp_material_id_fkey" FOREIGN KEY ("btp_material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cut_lines" ADD CONSTRAINT "casting_cut_lines_btp_inbound_id_fkey" FOREIGN KEY ("btp_inbound_id") REFERENCES "stock_inbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cut_images" ADD CONSTRAINT "casting_cut_images_cut_id_fkey" FOREIGN KEY ("cut_id") REFERENCES "casting_cuts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_cut_images" ADD CONSTRAINT "casting_cut_images_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "casting_cut_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
