/** Đếm quy mô dữ liệu để biết chỗ nào sắp nghẽn. Chạy: npx ts-node prisma/measure-volume.ts */
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from '../src/prisma/database-url';

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

async function main() {
  const [orders, split, subTickets, stages, stoneHolds, images, inbounds, outbounds, receipts] =
    await Promise.all([
      prisma.productionOrder.count(),
      prisma.productionOrder.count({ where: { subTickets: { some: {} } } }),
      prisma.productionSubTicket.count(),
      prisma.productionStageEntry.count(),
      prisma.productionStoneHold.count(),
      prisma.productionOrderImage.count(),
      prisma.stockInbound.count(),
      prisma.stockOutbound.count(),
      prisma.finishedGoodsReceipt.count(),
    ]);

  const rows: Array<[string, number]> = [
    ['Đơn sản xuất', orders],
    ['  trong đó đã chia phiếu con', split],
    ['Phiếu con', subTickets],
    ['Lượt giao khâu', stages],
    ['Dòng giữ đá', stoneHolds],
    ['Ảnh đơn', images],
    ['Phiếu nhập kho', inbounds],
    ['Phiếu xuất kho', outbounds],
    ['Phiếu nhập thành phẩm', receipts],
  ];
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(32)} ${String(value).padStart(7)}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
