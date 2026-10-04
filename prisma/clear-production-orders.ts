import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Xóa các lệnh sản xuất (đơn đã cắt cây thông hoặc tạo tay) và dữ liệu gắn đơn. Giữ đơn còn ở luồng
 * tạo đơn (chưa cắt cây). Đơn đã cắt bị xóa kèm dòng của nó trên phiếu đúc.
 */
async function main() {
  const outbounds = await prisma.stockOutbound.deleteMany({
    where: { productionOrderId: { not: null } },
  });
  const shipmentLines = await prisma.shipmentLine.deleteMany({});
  const shipments = await prisma.shipment.deleteMany({});
  const receipts = await prisma.finishedGoodsReceipt.deleteMany({});
  const started = { NOT: { intakeSeq: { not: null }, cutAt: null } };
  await prisma.castingSlipOrder.deleteMany({ where: { order: started } });
  const orders = await prisma.productionOrder.deleteMany({ where: started });

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
