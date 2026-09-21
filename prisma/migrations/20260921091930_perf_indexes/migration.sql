-- Chuẩn hoá 3 index perf cho mọi DB. DB dựng từ 0_init đã có đúng chúng (xoá rồi tạo lại, vô
-- hại). DB có sẵn baseline bằng `migrate resolve --applied 0_init` thì có thể thiếu chúng, hoặc
-- mang bản chạy tay từ prisma/sql/2026-09-21_perf_indexes.sql (khác tên / chiều sắp xếp) — sau
-- migration này DB nào cũng ra đúng schema.prisma.
DROP INDEX IF EXISTS "production_stage_entries_craftsman_returned_idx";
DROP INDEX IF EXISTS "production_stage_entries_craftsman_user_id_returned_at_idx";
DROP INDEX IF EXISTS "finished_goods_receipts_received_at_idx";
DROP INDEX IF EXISTS "stock_outbounds_production_order_id_idx";

-- CreateIndex
CREATE INDEX "finished_goods_receipts_received_at_idx" ON "finished_goods_receipts"("received_at");

-- CreateIndex
CREATE INDEX "production_stage_entries_craftsman_user_id_returned_at_idx" ON "production_stage_entries"("craftsman_user_id", "returned_at");

-- CreateIndex
CREATE INDEX "stock_outbounds_production_order_id_idx" ON "stock_outbounds"("production_order_id");
