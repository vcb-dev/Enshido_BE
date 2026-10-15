/**
 * Đếm số truy vấn SQL một lần đọc đồ thị đơn hàng phải bắn ra, và so với cách
 * đọc bằng JOIN. Chạy: npx ts-node prisma/measure-order-read.ts
 */
import { PrismaClient } from '@prisma/client';
import { detailInclude, workInclude } from '../src/production-orders/order-detail';
import { resolveDatabaseUrl } from '../src/prisma/database-url';

const prisma = new PrismaClient({
  log: [{ emit: 'event', level: 'query' }],
  datasources: { db: { url: resolveDatabaseUrl() } },
});

let count = 0;
let micros = 0;
prisma.$on('query', (event) => {
  count += 1;
  micros += event.duration;
});

async function measure(label: string, run: () => Promise<unknown>) {
  count = 0;
  micros = 0;
  const started = Date.now();
  await run();
  console.log(
    `${label.padEnd(34)} ${String(count).padStart(3)} truy vấn · ${String(Date.now() - started).padStart(5)} ms tường · ${micros} ms DB`,
  );
}

async function main() {
  const order = await prisma.productionOrder.findFirst({
    where: { stages: { some: {} } },
    orderBy: { seq: 'desc' },
    select: { id: true, code: true },
  });
  if (!order) throw new Error('Không có đơn nào để đo');
  console.log(`Đơn đo: ${order.code}\n`);

  // Làm nóng kết nối để lần đo đầu không tính luôn thời gian bắt tay.
  await prisma.productionOrder.findUnique({ where: { id: order.id } });

  await measure('workInclude (lúc thao tác)', () =>
    prisma.productionOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: workInclude,
    }),
  );
  await measure('detailInclude (GET chi tiết)', () =>
    prisma.productionOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: detailInclude,
    }),
  );
  await measure('workInclude + QUERY (tách lẻ)', () =>
    prisma.productionOrder.findUniqueOrThrow({
      relationLoadStrategy: 'query',
      where: { id: order.id },
      include: workInclude,
    }),
  );
  await measure('workInclude + JOIN', () =>
    prisma.productionOrder.findUniqueOrThrow({
      relationLoadStrategy: 'join',
      where: { id: order.id },
      include: workInclude,
    }),
  );
  await measure('detailInclude + JOIN', () =>
    prisma.productionOrder.findUniqueOrThrow({
      relationLoadStrategy: 'join',
      where: { id: order.id },
      include: detailInclude,
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
