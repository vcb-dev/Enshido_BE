-- Mô tả luồng bước 23: phiếu xuất hàng chờ kế toán xác nhận. Phiếu đã có trước bước này giữ
-- pending_approval = false (lập theo luật cũ, không cần duyệt) — không ghi người / ngày duyệt.
ALTER TABLE "shipments" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_name" TEXT,
ADD COLUMN     "approved_by_user_id" UUID,
ADD COLUMN     "pending_approval" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "shipments_pending_approval_idx" ON "shipments"("pending_approval");
