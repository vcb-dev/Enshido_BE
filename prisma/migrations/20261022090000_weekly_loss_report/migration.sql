-- Báo cáo hao hụt tuần: mức hao cho phép theo khâu + phiếu thu hồi mạt vụn cuối tuần.

-- CreateEnum
CREATE TYPE "LossStage" AS ENUM ('CASTING', 'FILING', 'STONE_SETTING', 'ENGRAVING', 'POLISHING', 'PLATING');

-- CreateEnum
CREATE TYPE "LossMetal" AS ENUM ('SILVER', 'GOLD');

-- CreateTable
CREATE TABLE "loss_limits" (
    "id" UUID NOT NULL,
    "stage" "LossStage" NOT NULL,
    "metal" "LossMetal" NOT NULL,
    "percent" DECIMAL(6,2) NOT NULL,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loss_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scrap_returns" (
    "id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "craftsman_user_id" UUID NOT NULL,
    "craftsman_name" TEXT NOT NULL,
    "weight_gram" DECIMAL(18,4) NOT NULL,
    "material_id" UUID NOT NULL,
    "inbound_id" UUID,
    "note" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "received_by_user_id" UUID,
    "received_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scrap_returns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loss_limits_stage_metal_key" ON "loss_limits"("stage", "metal");

-- CreateIndex
CREATE UNIQUE INDEX "scrap_returns_inbound_id_key" ON "scrap_returns"("inbound_id");

-- CreateIndex
CREATE INDEX "scrap_returns_week_start_idx" ON "scrap_returns"("week_start");

-- CreateIndex
CREATE INDEX "scrap_returns_craftsman_user_id_week_start_idx" ON "scrap_returns"("craftsman_user_id", "week_start");

-- Mức cho phép theo tab BÁO CÁO của "Mô tả luồng sản xuất kim hoàn.xlsx". Khắc / Xi tài liệu
-- không ghi mức nên để trống — thủ kho tự đặt.
INSERT INTO "loss_limits" ("id", "stage", "metal", "percent", "updated_at") VALUES
    (gen_random_uuid(), 'CASTING', 'SILVER', 1, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'FILING', 'SILVER', 6, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'STONE_SETTING', 'SILVER', 2, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'POLISHING', 'SILVER', 1, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'CASTING', 'GOLD', 0.5, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'FILING', 'GOLD', 3, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'STONE_SETTING', 'GOLD', 1.5, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'POLISHING', 'GOLD', 0.5, CURRENT_TIMESTAMP);
