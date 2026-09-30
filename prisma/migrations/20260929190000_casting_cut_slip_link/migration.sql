-- AlterTable
ALTER TABLE "casting_cuts" ADD COLUMN     "casting_slip_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "casting_cuts_casting_slip_id_key" ON "casting_cuts"("casting_slip_id");

-- AddForeignKey
ALTER TABLE "casting_cuts" ADD CONSTRAINT "casting_cuts_casting_slip_id_fkey" FOREIGN KEY ("casting_slip_id") REFERENCES "casting_slips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

