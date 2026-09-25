import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Xóa toàn bộ tồn / nhập / xuất kho thành phẩm (giữ lệnh sản xuất, bỏ phiếu chờ nhập). */
async function main() {
  const lines = await prisma.shipmentLine.deleteMany();
  const shipments = await prisma.shipment.deleteMany();
  const receipts = await prisma.finishedGoodsReceipt.deleteMany();
  const openingOrders = await prisma.productionOrder.deleteMany({
    where: { trackingCode: { startsWith: 'KHO-' } },
  });

  console.log(
    `Đã xóa ${receipts.count} phiếu tồn TP, ${lines.count} dòng xuất, ${shipments.count} phiếu xuất, ${openingOrders.count} đơn tồn đầu kỳ (KHO-).`,
  );
  console.log(
    'Đơn SX đang Hoàn thiện không còn phiếu chờ nhập — có thể chốt Hoàn thiện lại sau khi làm xong khâu.',
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
