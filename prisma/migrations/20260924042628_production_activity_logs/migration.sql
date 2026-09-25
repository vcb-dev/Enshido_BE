-- CreateTable
CREATE TABLE "production_activity_logs" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "order_code" TEXT NOT NULL,
    "sub_ticket_no" INTEGER,
    "stage" "ProductionStage",
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_name" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_activity_logs_order_id_created_at_idx" ON "production_activity_logs"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "production_activity_logs_order_code_created_at_idx" ON "production_activity_logs"("order_code", "created_at");

-- CreateIndex
CREATE INDEX "production_activity_logs_actor_user_id_created_at_idx" ON "production_activity_logs"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "production_activity_logs" ADD CONSTRAINT "production_activity_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

