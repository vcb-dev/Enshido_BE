/**
 * Hoàn kho phần các đơn cũ đã tự xuất lúc lên đơn (người dùng chốt 2026-09-25: lên đơn không
 * xuất kho nữa, NVL xuất ở từng bước giao khâu). Chỉ huỷ phiếu xuất "Xuất cho đơn …" và phiếu
 * xuất thành phẩm tự tạo; phiếu xuất lúc giao khâu / theo yêu cầu của thợ giữ nguyên.
 *
 *   npx ts-node prisma/revoke-order-auto-issues.ts          # chạy thử
 *   npx ts-node prisma/revoke-order-auto-issues.ts --apply  # hoàn kho
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductionOrdersService } from '../src/production-orders/production-orders.service';

async function main() {
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const prisma = app.get(PrismaService);
    const orders = app.get(ProductionOrdersService);
    const rows = await prisma.productionOrder.findMany({
      where: {
        OR: [
          {
            outbounds: {
              some: {
                autoIssued: true,
                materialRequest: null,
                note: { startsWith: 'Xuất cho đơn ' },
              },
            },
          },
          { autoShipments: { some: { autoIssued: true } } },
        ],
      },
      select: { id: true, code: true },
      orderBy: { seq: 'asc' },
    });
    for (const row of rows) {
      const result = await orders.revokeCreationIssues(row.id, !apply);
      const lines = result.outbounds
        .map((item) => `${item.name} ${item.qty.toString()} ${item.unitName}`)
        .join('; ');
      console.log(
        `${row.code}: ${lines || '—'}${result.shipments ? ` · ${result.shipments} phiếu xuất thành phẩm` : ''}`,
      );
    }
    console.log(
      apply
        ? `Đã hoàn kho ${rows.length} đơn.`
        : `Chạy thử: ${rows.length} đơn sẽ được hoàn kho. Thêm --apply để thực hiện.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
