import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

const WAREHOUSE_CODE = 'nvl-chinh';
/** Chỉ đẩy phiếu nhập từ ngày này trở đi. */
const FROM_DATE = '2026-10-01';
const ENTERED_BY = 'Admin Enshido';

/** Cột trên sheet "NHẬP ĐÁ"; dữ liệu bắt đầu từ dòng 4. */
type Row = {
  receivedAt: string;
  name: string;
  unit: string;
  qty: number;
  note: string;
  supplier: string;
};

const norm = (raw: string) =>
  raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Đọc sheet qua python vì máy không có thư viện xlsx cho Node. */
function readSheet(): Row[] {
  const json = execFileSync('python3', [
    '-c',
    `
import json, sys, datetime
sys.path.insert(0, '/tmp')
import xlsx

def cell(row, i):
    return row[i].strip() if len(row) > i and row[i] else ''

def day(raw):
    try:
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(raw)))).isoformat()
    except Exception:
        return ''

def money(raw):
    try:
        return float(raw)
    except Exception:
        return 0.0

out = []
for row in xlsx.load('/tmp/enshido-da.xlsx')['NHẬP ĐÁ'][3:]:
    name = cell(row, 2)
    received = day(cell(row, 1))
    if not name or not received:
        continue
    out.append({
        'receivedAt': received,
        'name': name,
        'unit': cell(row, 4),
        'qty': money(cell(row, 5)),
        'note': cell(row, 8),
        'supplier': cell(row, 10),
    })
print(json.dumps(out))
`,
  ]).toString();
  return JSON.parse(json) as Row[];
}

async function main() {
  const all = readSheet();
  const rows = all
    .filter((row) => row.receivedAt >= FROM_DATE)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  console.log(`Sheet có ${all.length} dòng, từ ${FROM_DATE} lấy ${rows.length} dòng.`);

  const warehouse = await prisma.warehouse.findUniqueOrThrow({
    where: { code: WAREHOUSE_CODE },
    select: { id: true, name: true },
  });

  const [materials, units, suppliers, last] = await Promise.all([
    prisma.material.findMany({
      where: { warehouseId: warehouse.id },
      select: { id: true, sku: true, name: true, unitId: true },
    }),
    prisma.unit.findMany({ select: { id: true, name: true } }),
    prisma.supplier.findMany({ select: { id: true, name: true } }),
    prisma.stockInbound.aggregate({
      where: { warehouseId: warehouse.id },
      _max: { sortOrder: true },
    }),
  ]);
  const materialBy = new Map(materials.map((m) => [norm(m.name), m]));
  const unitBy = new Map(units.map((u) => [norm(u.name), u]));
  const supplierBy = new Map(suppliers.map((s) => [norm(s.name), s]));

  let sortOrder = (last._max.sortOrder ?? 0) + 1;
  let created = 0;
  let totalQty = 0;

  for (const row of rows) {
    const material = materialBy.get(norm(row.name));
    if (!material) {
      console.warn(`  bỏ qua — không tìm thấy NVL "${row.name}"`);
      continue;
    }
    const unit = unitBy.get(norm(row.unit));
    const supplier = row.supplier ? supplierBy.get(norm(row.supplier)) : undefined;
    if (row.supplier && !supplier) console.warn(`  NCC chưa có: "${row.supplier}"`);

    const qty = new Prisma.Decimal(row.qty);

    await prisma.stockInbound.create({
      data: {
        warehouseId: warehouse.id,
        materialId: material.id,
        sortOrder: sortOrder++,
        receivedAt: new Date(`${row.receivedAt}T09:00:00+07:00`),
        name: material.name,
        sku: material.sku,
        unitId: unit?.id ?? material.unitId,
        unitName: unit?.name ?? row.unit,
        qty,
        // Đơn giá / thành tiền để trống, bổ sung sau khi chốt lại giá.
        note: row.note || null,
        enteredBy: ENTERED_BY,
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? row.supplier ?? null,
        // Seed lịch sử: tồn kho đã nhập theo cột TỒN KHO nên không cộng thêm lần nữa.
        applyToStock: false,
      },
    });
    created++;
    totalQty += row.qty;
  }

  console.log(
    `\nĐã tạo ${created} phiếu nhập vào ${warehouse.name}: tổng SL ${totalQty.toLocaleString('vi-VN')}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
