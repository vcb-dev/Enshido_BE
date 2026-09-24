-- Khách hàng trên đơn sản xuất.
ALTER TABLE "production_orders"
    ADD COLUMN "customer_name" TEXT;

-- Lịch sử lý do chỉnh sửa.
CREATE TABLE "edit_logs" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "edit_logs_entity_type_entity_id_changed_at_idx"
    ON "edit_logs"("entity_type", "entity_id", "changed_at");
