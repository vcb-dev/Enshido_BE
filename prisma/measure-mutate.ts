/**
 * Bóc tách chi phí một lần bấm nút thao tác sản xuất: bao nhiêu là độ trễ mạng tới
 * database, bao nhiêu là đọc đồ thị đơn hàng. Không ghi gì — transaction bị rollback.
 * Chạy: npx ts-node prisma/measure-mutate.ts
 */
import { PrismaClient } from '@prisma/client';
import { workInclude } from '../src/production-orders/order-detail';
import { resolveDatabaseUrl } from '../src/prisma/database-url';

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

const ROUNDS = 7;

class Rollback extends Error {}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function repeat(label: string, run: () => Promise<unknown>) {
  const runs: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const started = Date.now();
    await run();
    runs.push(Date.now() - started);
  }
  console.log(
    `${label.padEnd(44)} ${String(median(runs)).padStart(5)} ms (giữa) · ${String(Math.min(...runs)).padStart(5)} ms (nhanh nhất)`,
  );
  return median(runs);
}

async function main() {
  const order = await prisma.productionOrder.findFirst({
    where: { stages: { some: {} } },
    orderBy: { seq: 'desc' },
    select: { id: true, code: true },
  });
  if (!order) throw new Error('Không có đơn nào để đo');
  console.log(`Đơn đo: ${order.code}\n`);

  const ping = await repeat('1 lượt đi-về tới database (SELECT 1)', () =>
    prisma.$queryRaw`SELECT 1`,
  );

  const idRead = await repeat('Tra id đơn theo mã', () =>
    prisma.productionOrder.findUnique({
      where: { code: order.code },
      select: { id: true },
    }),
  );

  const graphRead = await repeat('Đọc đồ thị đơn (workInclude)', () =>
    prisma.productionOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: workInclude,
    }),
  );

  // Đúng hình dạng transaction của mutate(): set_config + khóa dòng + đọc đồ thị.
  // Ném lỗi ở cuối để rollback, không ghi gì vào database.
  const txPart = await repeat('Transaction có khóa dòng + đọc đồ thị', async () => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('search_path', 'enshido', true)`;
        await tx.$queryRaw`SELECT id FROM enshido.production_orders WHERE id = ${order.id}::uuid FOR UPDATE`;
        await tx.productionOrder.findUniqueOrThrow({
          where: { id: order.id },
          include: workInclude,
        });
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });

  const total = idRead + txPart + graphRead;
  console.log(
    `\nTổng một lần bấm nút (chưa tính phần ghi):  ${total} ms` +
      `\n  trong đó riêng độ trễ mạng tới database: ~${ping} ms mỗi lượt đi-về`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
