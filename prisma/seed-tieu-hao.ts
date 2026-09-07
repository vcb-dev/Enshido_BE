import { MaterialClass, PrismaClient } from '@prisma/client';

/// Seed kho NVL tiêu hao: danh mục + 6 NVL mẫu + 6 phiếu nhập + 6 phiếu xuất.
/// Chạy riêng bằng `pnpm prisma:seed:tieu-hao` để không đụng users và kho đá,
/// hoặc được `prisma/seed.ts` gọi lại trong lượt seed đầy đủ.

/// Ngưỡng "Sắp hết hàng" — khớp công thức IF(tồn<3) trên sheet Excel.
const REORDER_POINT = '3';

const UNITS = [
  { code: 'chiec', name: 'chiếc', sortOrder: 10 },
  { code: 'cai', name: 'cái', sortOrder: 11 },
  { code: 'tui', name: 'túi', sortOrder: 12 },
  { code: 'hop', name: 'hộp', sortOrder: 13 },
  { code: 'kg', name: 'kg', sortOrder: 14 },
  // 'bo' đã là "bộ" của kho đá nên "bó" phải dùng mã khác.
  { code: 'bo-vat-lieu', name: 'bó', sortOrder: 15 },
  { code: 'doi', name: 'đôi', sortOrder: 16 },
  { code: 'lo', name: 'lọ', sortOrder: 17 },
  { code: 'lit', name: 'lít', sortOrder: 18 },
];

const MATERIAL_TYPES = [
  { code: 'ccdc', name: 'CCDC', sortOrder: 5 },
  { code: 'nvl-phu', name: 'NVL phụ', sortOrder: 6 },
];

const SUPPLIERS = [
  { code: 'ngoc-thang', name: 'Ngọc Thắng', sortOrder: 3 },
  { code: 'tien-phat', name: 'Tiến Phát', sortOrder: 4 },
  { code: 'shopee', name: 'Shopee', sortOrder: 5 },
];

/// 6 NVL lấy từ sheet "BẢNG NXT MỚI", phủ cả 3 trạng thái tồn và 2 nhóm CCDC / NVL phụ.
/// countedQty/countedAt = kết quả kiểm kê tay (cột "Tồn thực tế"); bỏ trống là chưa kiểm kê.
const MATERIALS: {
  sku: string;
  name: string;
  unitCode: string;
  typeCode: string;
  sortOrder: number;
  openingQty: string;
  stockUnitPrice: string;
  countedQty?: string;
  countedAt?: string;
}[] = [
  { sku: 'TH-001', name: 'Mũi dù HD 0.9', unitCode: 'chiec', typeCode: 'ccdc', sortOrder: 1, openingQty: '5', stockUnitPrice: '22000', countedQty: '30', countedAt: '2026-09-07' },
  { sku: 'TH-002', name: 'Mũi dù HD 10', unitCode: 'chiec', typeCode: 'ccdc', sortOrder: 2, openingQty: '9', stockUnitPrice: '23714' },
  { sku: 'TH-003', name: 'Nòng nhẫn Inox', unitCode: 'chiec', typeCode: 'ccdc', sortOrder: 3, openingQty: '1', stockUnitPrice: '191667' },
  { sku: 'TH-004', name: 'Kìm nhật', unitCode: 'cai', typeCode: 'ccdc', sortOrder: 4, openingQty: '3', stockUnitPrice: '213636' },
  { sku: 'TH-005', name: 'Lưỡi cưa', unitCode: 'bo-vat-lieu', typeCode: 'ccdc', sortOrder: 5, openingQty: '1', stockUnitPrice: '30500', countedQty: '13', countedAt: '2026-09-07' },
  { sku: 'TH-006', name: 'Xăng', unitCode: 'lit', typeCode: 'nvl-phu', sortOrder: 6, openingQty: '0', stockUnitPrice: '66250', countedQty: '20', countedAt: '2026-09-07' },
];

const INBOUNDS = [
  { stt: 1, date: '2026-05-04', sku: 'TH-001', qty: '60', unitPrice: '22000', supplierCode: 'ngoc-thang', note: null },
  { stt: 2, date: '2026-05-04', sku: 'TH-006', qty: '40', unitPrice: '66250', supplierCode: 'ngoc-thang', note: 'Xăng chạy máy' },
  { stt: 3, date: '2026-05-11', sku: 'TH-004', qty: '2', unitPrice: '235000', supplierCode: 'tien-phat', note: null },
  { stt: 4, date: '2026-05-18', sku: 'TH-005', qty: '20', unitPrice: '30500', supplierCode: 'ngoc-thang', note: null },
  { stt: 5, date: '2026-06-02', sku: 'TH-003', qty: '6', unitPrice: '191667', supplierCode: 'tien-phat', note: 'Setup bàn nguội' },
  { stt: 6, date: '2026-06-15', sku: 'TH-002', qty: '42', unitPrice: '23714', supplierCode: 'shopee', note: null },
];

const OUTBOUNDS = [
  { stt: 1, date: '2026-05-06', sku: 'TH-001', qty: '33', unitPrice: '22000', issuedBy: 'Nguyễn Mai', receivedBy: 'Đăng Huy', note: null },
  { stt: 2, date: '2026-05-12', sku: 'TH-006', qty: '20', unitPrice: '66250', issuedBy: 'Nguyễn Mai', receivedBy: 'Lê Văn Hoàng', note: null },
  { stt: 3, date: '2026-05-20', sku: 'TH-004', qty: '5', unitPrice: '213636', issuedBy: 'Nguyễn Mai', receivedBy: 'Lân', note: 'Setup bùi lân' },
  { stt: 4, date: '2026-06-05', sku: 'TH-005', qty: '10', unitPrice: '30500', issuedBy: 'Nguyễn Mai', receivedBy: 'Văn An', note: null },
  { stt: 5, date: '2026-06-20', sku: 'TH-003', qty: '5', unitPrice: '191667', issuedBy: 'Nguyễn Mai', receivedBy: 'Lân', note: null },
  { stt: 6, date: '2026-07-01', sku: 'TH-002', qty: '21', unitPrice: '23714', issuedBy: 'Nguyễn Mai', receivedBy: 'Thuý Hoài', note: null },
];

function seedDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function money(qty: string, unitPrice: string) {
  return String(Number(qty) * Number(unitPrice));
}

async function seedLookups(prisma: PrismaClient) {
  for (const row of UNITS) {
    await prisma.unit.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }
  for (const row of MATERIAL_TYPES) {
    await prisma.materialType.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }
  for (const row of SUPPLIERS) {
    await prisma.supplier.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }
}

async function warehouse(prisma: PrismaClient) {
  const row = await prisma.warehouse.findUnique({ where: { code: 'nvl-tieu-hao' } });
  if (!row) throw new Error('Thiếu kho nvl-tieu-hao — chạy seed.ts trước.');
  return row;
}

/// Master NVL + tồn đầu kỳ. Nhập/xuất do phiếu quyết định nên không set cứng ở đây.
async function seedStock(prisma: PrismaClient) {
  const kho = await warehouse(prisma);
  const units = await prisma.unit.findMany({ select: { id: true, code: true } });
  const unitByCode = new Map(units.map((u) => [u.code, u.id]));
  const types = await prisma.materialType.findMany({ select: { id: true, code: true } });
  const typeByCode = new Map(types.map((t) => [t.code, t.id]));

  for (const row of MATERIALS) {
    const unitId = unitByCode.get(row.unitCode);
    if (!unitId) throw new Error(`Thiếu đơn vị tính: ${row.unitCode}`);
    const data = {
      name: row.name,
      unitId,
      materialTypeId: typeByCode.get(row.typeCode) ?? null,
      classification: MaterialClass.CONSUMABLE,
      reorderPoint: REORDER_POINT,
      sortOrder: row.sortOrder,
    };
    const material = await prisma.material.upsert({
      where: { warehouseId_sku: { warehouseId: kho.id, sku: row.sku } },
      update: { ...data, isActive: true },
      create: { ...data, warehouseId: kho.id, sku: row.sku },
    });

    const balance = {
      warehouseId: kho.id,
      openingQty: row.openingQty,
      openingAmount: money(row.openingQty, row.stockUnitPrice),
      stockUnitPrice: row.stockUnitPrice,
      countedQty: row.countedQty ?? null,
      countedAt: row.countedAt ? seedDate(row.countedAt) : null,
    };
    await prisma.stockBalance.upsert({
      where: { materialId: material.id },
      update: balance,
      create: { ...balance, materialId: material.id },
    });
  }
}

async function materialsBySku(prisma: PrismaClient, warehouseId: string) {
  const rows = await prisma.material.findMany({
    where: { warehouseId, isActive: true },
    select: { id: true, sku: true, name: true, unitId: true, unit: { select: { name: true } } },
  });
  return new Map(rows.filter((m) => m.sku).map((m) => [m.sku as string, m]));
}

async function seedInbounds(prisma: PrismaClient) {
  const kho = await warehouse(prisma);
  const bySku = await materialsBySku(prisma, kho.id);
  const suppliers = await prisma.supplier.findMany({ select: { id: true, code: true, name: true } });
  const supplierByCode = new Map(suppliers.map((s) => [s.code, s]));

  for (const row of INBOUNDS) {
    const material = bySku.get(row.sku);
    if (!material) throw new Error(`Thiếu NVL tiêu hao: ${row.sku}`);
    const supplier = supplierByCode.get(row.supplierCode) ?? null;
    const data = {
      receivedAt: seedDate(row.date),
      name: material.name,
      sku: material.sku,
      unitId: material.unitId,
      unitName: material.unit.name,
      qty: row.qty,
      unitPrice: row.unitPrice,
      amount: money(row.qty, row.unitPrice),
      note: row.note,
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      materialId: material.id,
      // true để phiếu được cộng vào cột Nhập của kho tồn.
      applyToStock: true,
    };
    await prisma.stockInbound.upsert({
      where: { warehouseId_sortOrder: { warehouseId: kho.id, sortOrder: row.stt } },
      update: data,
      create: { ...data, warehouseId: kho.id, sortOrder: row.stt },
    });
  }
}

async function seedOutbounds(prisma: PrismaClient) {
  const kho = await warehouse(prisma);
  const bySku = await materialsBySku(prisma, kho.id);

  for (const row of OUTBOUNDS) {
    const material = bySku.get(row.sku);
    if (!material) throw new Error(`Thiếu NVL tiêu hao: ${row.sku}`);
    const data = {
      issuedAt: seedDate(row.date),
      name: material.name,
      sku: material.sku,
      unitId: material.unitId,
      unitName: material.unit.name,
      qty: row.qty,
      inboundUnitPrice: row.unitPrice,
      amount: money(row.qty, row.unitPrice),
      note: row.note,
      issuedBy: row.issuedBy,
      receivedBy: row.receivedBy,
      materialId: material.id,
      applyToStock: true,
    };
    await prisma.stockOutbound.upsert({
      where: { warehouseId_sortOrder: { warehouseId: kho.id, sortOrder: row.stt } },
      update: data,
      create: { ...data, warehouseId: kho.id, sortOrder: row.stt },
    });
  }
}

/// Ghi lại các cột NXT lưu sẵn trên stock_balances cho khớp phiếu.
/// API tính tồn động nên không ảnh hưởng hiển thị, nhưng để dữ liệu at-rest không bị cũ.
async function recomputeBalances(prisma: PrismaClient) {
  const kho = await warehouse(prisma);
  const materials = await prisma.material.findMany({
    where: { warehouseId: kho.id },
    select: { id: true, balance: { select: { openingQty: true, openingAmount: true } } },
  });

  for (const m of materials) {
    const [ins, outs] = await Promise.all([
      prisma.stockInbound.findMany({
        where: { warehouseId: kho.id, materialId: m.id, applyToStock: true, qty: { gt: 0 } },
        select: { qty: true, unitPrice: true },
      }),
      prisma.stockOutbound.findMany({
        where: { warehouseId: kho.id, materialId: m.id, applyToStock: true, qty: { gt: 0 } },
        select: { qty: true, inboundUnitPrice: true, amount: true },
      }),
    ]);
    const inQty = ins.reduce((a, r) => a + Number(r.qty), 0);
    const inAmount = ins.reduce((a, r) => a + Number(r.qty) * Number(r.unitPrice), 0);
    const outQty = outs.reduce((a, r) => a + Number(r.qty), 0);
    const outAmount = outs.reduce(
      (a, r) => a + (Number(r.amount) > 0 ? Number(r.amount) : Number(r.qty) * Number(r.inboundUnitPrice)),
      0,
    );
    const openingQty = Number(m.balance?.openingQty ?? 0);
    const openingAmount = Number(m.balance?.openingAmount ?? 0);

    await prisma.stockBalance.update({
      where: { materialId: m.id },
      data: {
        inQty: String(inQty),
        inAmount: String(inAmount),
        outQty: String(outQty),
        outAmount: String(outAmount),
        qty: String(openingQty + inQty - outQty),
        amount: String(openingAmount + inAmount - outAmount),
      },
    });
  }
}

export async function seedTieuHao(prisma: PrismaClient) {
  await seedLookups(prisma);
  await seedStock(prisma);
  await seedInbounds(prisma);
  await seedOutbounds(prisma);
  await recomputeBalances(prisma);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedTieuHao(prisma)
    .then(() => {
      console.log('Seed kho NVL tiêu hao OK');
      console.log(`  danh mục: ${UNITS.length} đơn vị, ${MATERIAL_TYPES.length} nhóm, ${SUPPLIERS.length} NCC`);
      console.log(`  ${MATERIALS.length} NVL mẫu, ${INBOUNDS.length} phiếu nhập, ${OUTBOUNDS.length} phiếu xuất`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
