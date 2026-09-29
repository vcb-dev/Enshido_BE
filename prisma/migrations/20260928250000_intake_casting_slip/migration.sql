ALTER TYPE "IntakeOrderStatus" ADD VALUE IF NOT EXISTS 'WAIT_CASTING';

CREATE TABLE "casting_slips" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "slip_date" DATE NOT NULL,
    "intake_order_id" UUID NOT NULL,
    "wax_weight_gram" DECIMAL(18, 4) NOT NULL,
    "batch_order_codes" TEXT NOT NULL,
    "issue_s999_gram" DECIMAL(18, 4),
    "issue_master_alloy_gram" DECIMAL(18, 4),
    "issue_s925_gram" DECIMAL(18, 4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casting_slips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "casting_slips_code_key" ON "casting_slips"("code");
CREATE UNIQUE INDEX "casting_slips_intake_order_id_key" ON "casting_slips"("intake_order_id");
CREATE INDEX "casting_slips_slip_date_idx" ON "casting_slips"("slip_date");

ALTER TABLE "casting_slips"
    ADD CONSTRAINT "casting_slips_intake_order_id_fkey"
    FOREIGN KEY ("intake_order_id") REFERENCES "intake_orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "casting_slip_images" (
    "id" UUID NOT NULL,
    "slip_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "casting_slip_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "casting_slip_images_slip_id_sort_order_idx" ON "casting_slip_images"("slip_id", "sort_order");

ALTER TABLE "casting_slip_images"
    ADD CONSTRAINT "casting_slip_images_slip_id_fkey"
    FOREIGN KEY ("slip_id") REFERENCES "casting_slips"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
