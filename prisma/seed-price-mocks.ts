import { MaterialClass, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DAYS_MS = 24 * 60 * 60 * 1000;

const PRICE_MOCKS: Array<{
  warehouseCode: string;
  classification: MaterialClass;
  items: Array<{
    sku: string;
    name: string;
    unitCode: string;
    openingQty: string;
    stockUnitPrice: string;
    note: string;
    daysAgo: number;
  }>;
}> = [
  {
    warehouseCode: 'da',
    classification: MaterialClass.RAW_MATERIAL,
    items: [
      {
        sku: 'ST-CZ',
        name: 'Đá CZ',
        unitCode: 'vien',
        openingQty: '50',
        stockUnitPrice: '15000',
        note: 'Mock đơn giá tồn kho đá',
        daysAgo: 12,
      },
      {
        sku: 'ST-SYN',
        name: 'Đá tổng hợp',
        unitCode: 'vien',
        openingQty: '20',
        stockUnitPrice: '80000',
        note: 'Mock đơn giá tồn kho đá',
        daysAgo: 7,
      },
      {
        sku: 'ST-NAT',
        name: 'Đá thiên nhiên',
        unitCode: 'vien',
        openingQty: '10',
        stockUnitPrice: '250000',
        note: 'Mock đơn giá tồn kho đá',
        daysAgo: 3,
      },
    ],
  },
  {
    warehouseCode: 'bac',
    classification: MaterialClass.RAW_MATERIAL,
    items: [
      {
        sku: 'AG-999',
        name: 'Bạc 999',
        unitCode: 'gram',
        openingQty: '500',
        stockUnitPrice: '28000',
        note: 'Mock đơn giá tồn kho bạc',
        daysAgo: 15,
      },
      {
        sku: 'AG-925',
        name: 'Bạc 925',
        unitCode: 'gram',
        openingQty: '300',
        stockUnitPrice: '22000',
        note: 'Mock đơn giá tồn kho bạc',
        daysAgo: 9,
      },
      {
        sku: 'AG-WIRE',
        name: 'Dây bạc',
        unitCode: 'met',
        openingQty: '15',
        stockUnitPrice: '45000',
        note: 'Mock đơn giá tồn kho bạc',
        daysAgo: 4,
      },
    ],
  },
  {
    warehouseCode: 'nvl-tieu-hao',
    classification: MaterialClass.CONSUMABLE,
    items: [
      {
        sku: 'CS-GLUE',
        name: 'Keo gắn',
        unitCode: 'chai',
        openingQty: '8',
        stockUnitPrice: '35000',
        note: 'Mock đơn giá tồn NVL tiêu hao',
        daysAgo: 20,
      },
      {
        sku: 'CS-SAND',
        name: 'Giấy nhám',
        unitCode: 'to',
        openingQty: '40',
        stockUnitPrice: '5000',
        note: 'Mock đơn giá tồn NVL tiêu hao',
        daysAgo: 11,
      },
      {
        sku: 'CS-POL',
        name: 'Sáp đánh bóng',
        unitCode: 'thoi',
        openingQty: '12',
        stockUnitPrice: '25000',
        note: 'Mock đơn giá tồn NVL tiêu hao',
        daysAgo: 6,
      },
    ],
  },
];

async function ensureUnits() {
  for (const row of [
    { code: 'chai', name: 'chai', sortOrder: 7 },
    { code: 'to', name: 'tờ', sortOrder: 8 },
    { code: 'thoi', name: 'thỏi', sortOrder: 9 },
  ]) {
    await prisma.unit.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }
}

async function upsertPriceItem(
  warehouse: { id: string },
  classification: MaterialClass,
  unit: { id: string; name: string },
  item: (typeof PRICE_MOCKS)[number]['items'][number],
  sortOrder: number,
) {
  const createdAt = new Date(Date.now() - item.daysAgo * DAYS_MS);
  const openingQty = item.openingQty;
  const stockUnitPrice = item.stockUnitPrice;
  const openingAmount = String(Number(openingQty) * Number(stockUnitPrice));

  const material = await prisma.material.upsert({
    where: { warehouseId_sku: { warehouseId: warehouse.id, sku: item.sku } },
    update: {
      name: item.name,
      unitId: unit.id,
      note: item.note,
      classification,
      sortOrder,
      isActive: true,
    },
    create: {
      warehouseId: warehouse.id,
      sku: item.sku,
      name: item.name,
      unitId: unit.id,
      note: item.note,
      classification,
      sortOrder,
      createdAt,
    },
  });

  await prisma.stockBalance.upsert({
    where: { materialId: material.id },
    update: {
      warehouseId: warehouse.id,
      openingQty,
      openingAmount,
      stockUnitPrice,
      qty: openingQty,
      amount: openingAmount,
    },
    create: {
      warehouseId: warehouse.id,
      materialId: material.id,
      openingQty,
      openingAmount,
      stockUnitPrice,
      qty: openingQty,
      amount: openingAmount,
    },
  });
}

async function priceExistingDaMois() {
  const warehouse = await prisma.warehouse.findUnique({ where: { code: 'da' } });
  if (!warehouse) return;
  const mois = await prisma.material.findFirst({
    where: { warehouseId: warehouse.id, isActive: true, name: { contains: 'mois', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!mois) return;
  const balance = await prisma.stockBalance.findUnique({
    where: { materialId: mois.id },
    select: { openingQty: true, stockUnitPrice: true },
  });
  if (!balance || !balance.stockUnitPrice.isZero()) return;
  const openingQty = balance.openingQty;
  const stockUnitPrice = '50000';
  const openingAmount = openingQty.mul(stockUnitPrice).toDecimalPlaces(2);
  await prisma.stockBalance.update({
    where: { materialId: mois.id },
    data: { stockUnitPrice, openingAmount, amount: openingAmount },
  });
  const current = await prisma.material.findUnique({
    where: { id: mois.id },
    select: { note: true },
  });
  if (!current?.note) {
    await prisma.material.update({
      where: { id: mois.id },
      data: { note: 'Mock đơn giá tồn kho đá' },
    });
  }
}

async function main() {
  await ensureUnits();

  for (const group of PRICE_MOCKS) {
    const warehouse = await prisma.warehouse.findUnique({ where: { code: group.warehouseCode } });
    if (!warehouse) throw new Error(`Thiếu kho ${group.warehouseCode}`);
    for (const [index, item] of group.items.entries()) {
      const unit = await prisma.unit.findUnique({ where: { code: item.unitCode } });
      if (!unit) throw new Error(`Thiếu đơn vị ${item.unitCode}`);
      await upsertPriceItem(warehouse, group.classification, unit, item, index + 1);
      console.log(`  ${group.warehouseCode}: ${item.name} — ${item.stockUnitPrice}`);
    }
  }

  await priceExistingDaMois();
  console.log('Seed mock cấu hình giá: 3 NVL × 3 kho, đều có đơn giá tồn.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
