-- Bước 7: bạc S999 / hội / S925 cấp cho phiếu đúc xuất khỏi kho NVL chính.
ALTER TABLE "stock_outbounds" ADD COLUMN     "casting_slip_id" UUID;

-- CreateIndex
CREATE INDEX "stock_outbounds_casting_slip_id_idx" ON "stock_outbounds"("casting_slip_id");

-- AddForeignKey
ALTER TABLE "stock_outbounds" ADD CONSTRAINT "stock_outbounds_casting_slip_id_fkey" FOREIGN KEY ("casting_slip_id") REFERENCES "casting_slips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
