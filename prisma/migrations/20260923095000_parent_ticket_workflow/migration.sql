ALTER TABLE "production_orders"
ADD COLUMN "pending_stage" "ProductionStage",
ADD COLUMN "pending_at" TIMESTAMP(3),
ADD COLUMN "pending_by_name" TEXT,
ADD COLUMN "claimed_by_user_id" UUID,
ADD COLUMN "claimed_by_name" TEXT,
ADD COLUMN "claimed_at" TIMESTAMP(3);

CREATE INDEX "production_orders_pending_stage_claimed_by_user_id_idx"
ON "production_orders"("pending_stage", "claimed_by_user_id");

CREATE INDEX "production_orders_claimed_by_user_id_idx"
ON "production_orders"("claimed_by_user_id");
