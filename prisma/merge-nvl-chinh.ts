import { MetalKind, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resequenceInbounds(warehouseId: string) {
  const rows = await prisma.stockInbound.findMany({
    where: { warehouseId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  for (const [index, row] of rows.entries()) {
    await prisma.stockInbound.update({
      where: { id: row.id },
      data: { sortOrder: 1_000_000 + index },
    });
  }
  for (const [index, row] of rows.entries()) {
    await prisma.stockInbound.update({
      where: { id: row.id },
      data: { sortOrder: index + 1 },
    });
  }
}

async function resequenceOutbounds(warehouseId: string) {
  const rows = await prisma.stockOutbound.findMany({
    where: { warehouseId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  for (const [index, row] of rows.entries()) {
    await prisma.stockOutbound.update({
      where: { id: row.id },
      data: { sortOrder: 1_000_000 + index },
    });
  }
  for (const [index, row] of rows.entries()) {
    await prisma.stockOutbound.update({
      where: { id: row.id },
      data: { sortOrder: index + 1 },
    });
  }
}

async function moveWarehouse(
  sourceCode: string,
  targetId: string,
  metalKind: MetalKind,
  bacTypeId?: string | null,
) {
  const source = await prisma.warehouse.findUnique({ where: { code: sourceCode } });
  if (!source || source.id === targetId) return 0;

  const existing = await prisma.material.findMany({
    where: { warehouseId: targetId },
    select: { sku: true, sortOrder: true },
  });
  const usedSku = new Set(existing.map((row) => row.sku).filter(Boolean) as string[]);
  const maxSort = existing.reduce((max, row) => Math.max(max, row.sortOrder), 0);

  const materials = await prisma.material.findMany({
    where: { warehouseId: source.id },
    orderBy: { sortOrder: 'asc' },
  });

  for (const [index, material] of materials.entries()) {
    let sku = material.sku;
    if (sku && usedSku.has(sku)) sku = `${sku}-${sourceCode}`;
    if (sku) usedSku.add(sku);
    await prisma.material.update({
      where: { id: material.id },
      data: {
        warehouseId: targetId,
        sku,
        metalKind: material.metalKind ?? metalKind,
        materialTypeId:
          material.materialTypeId ??
          (sourceCode === 'bac' ? bacTypeId : material.materialTypeId),
        sortOrder: maxSort + index + 1,
      },
    });
  }

  const inboundMax = await prisma.stockInbound.aggregate({
    where: { warehouseId: targetId },
    _max: { sortOrder: true },
  });
  const outboundMax = await prisma.stockOutbound.aggregate({
    where: { warehouseId: targetId },
    _max: { sortOrder: true },
  });
  await prisma.stockInbound.updateMany({
    where: { warehouseId: source.id },
    data: { sortOrder: { increment: (inboundMax._max.sortOrder ?? 0) + 1000 } },
  });
  await prisma.stockOutbound.updateMany({
    where: { warehouseId: source.id },
    data: { sortOrder: { increment: (outboundMax._max.sortOrder ?? 0) + 1000 } },
  });

  await prisma.stockBalance.updateMany({
    where: { warehouseId: source.id },
    data: { warehouseId: targetId },
  });
  await prisma.stockInbound.updateMany({
    where: { warehouseId: source.id },
    data: { warehouseId: targetId },
  });
  await prisma.stockOutbound.updateMany({
    where: { warehouseId: source.id },
    data: { warehouseId: targetId },
  });

  return materials.length;
}

async function main() {
  const nvlChinh = await prisma.warehouse.findUnique({ where: { code: 'nvl-chinh' } });
  if (!nvlChinh) throw new Error('Thiếu kho nvl-chinh');

  for (const row of [
    { code: 'da-moiss', name: 'Đá Moiss', sortOrder: 1 },
    { code: 'da-cz', name: 'Đá CZ', sortOrder: 2 },
    { code: 'da-dz', name: 'Đá DZ', sortOrder: 3 },
    { code: 'da-quy-khac', name: 'Đá quý khác', sortOrder: 4 },
    { code: 'da-thuong', name: 'Đá thường', sortOrder: 5 },
    { code: 'bac', name: 'Bạc', sortOrder: 6 },
    { code: 'vang', name: 'Vàng', sortOrder: 7 },
  ]) {
    await prisma.materialType.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }

  const bacType = await prisma.materialType.findUnique({ where: { code: 'bac' } });

  await prisma.warehouse.update({
    where: { id: nvlChinh.id },
    data: {
      name: 'Kho nguyên vật liệu chính',
      shortName: 'Kho NVL chính',
      description: 'Nhập, xuất và tồn nguyên vật liệu chính.',
      parentId: null,
      isActive: true,
    },
  });

  const movedBac = await moveWarehouse('bac', nvlChinh.id, MetalKind.SILVER, bacType?.id);
  const movedDa = await moveWarehouse('da', nvlChinh.id, MetalKind.SILVER);
  await resequenceInbounds(nvlChinh.id);
  await resequenceOutbounds(nvlChinh.id);

  await prisma.material.updateMany({
    where: { warehouseId: nvlChinh.id, metalKind: null },
    data: { metalKind: MetalKind.SILVER },
  });

  for (const code of ['bac', 'da']) {
    await prisma.warehouse.updateMany({
      where: { code },
      data: { isActive: false },
    });
  }

  console.log(`Đã gộp kho bạc (${movedBac} NVL) và kho đá (${movedDa} NVL) vào Kho NVL chính.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
