import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [inbounds, outbounds] = await Promise.all([
    prisma.stockInbound.deleteMany(),
    prisma.stockOutbound.deleteMany(),
  ]);

  const balances = await prisma.stockBalance.findMany({
    select: { id: true, openingQty: true, openingAmount: true },
  });
  for (const row of balances) {
    await prisma.stockBalance.update({
      where: { id: row.id },
      data: {
        inQty: 0,
        inAmount: 0,
        outQty: 0,
        outAmount: 0,
        qty: row.openingQty,
        amount: row.openingAmount,
      },
    });
  }

  console.log(
    `Đã xóa ${inbounds.count} phiếu nhập, ${outbounds.count} phiếu xuất. Tồn kho = đầu kỳ.`,
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
