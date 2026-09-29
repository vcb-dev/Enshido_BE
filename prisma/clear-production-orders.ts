import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Xóa toàn bộ lệnh sản xuất và dữ liệu gắn đơn (giữ phiếu Tạo đơn / intake). */
async function main() {
  const outbounds = await prisma.stockOutbound.deleteMany({
    where: { productionOrderId: { not: null } },
  });
  const shipmentLines = await prisma.shipmentLine.deleteMany({});
  const shipments = await prisma.shipment.deleteMany({});
  const receipts = await prisma.finishedGoodsReceipt.deleteMany({});
  const orders = await prisma.productionOrder.deleteMany({});

  console.log(
    `Đã xóa ${orders.count} lệnh SX, ${receipts.count} phiếu TP chờ nhập, ${outbounds.count} phiếu xuất gắn đơn, ${shipmentLines.count} dòng xuất TP, ${shipments.count} phiếu xuất TP.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
