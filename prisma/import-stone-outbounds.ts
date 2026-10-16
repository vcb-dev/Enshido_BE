import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

const WAREHOUSE_CODE = 'nvl-chinh';
/** Chỉ đẩy phiếu xuất từ ngày này trở đi. */
const FROM_DATE = '2026-10-01';
const DRY_RUN = process.env.DRY_RUN === '1';

/** Cột trên sheet "XUẤT  ĐÁ"; dữ liệu bắt đầu từ dòng 4. */
type Row = {
  issuedAt: string;
  name: string;
  unit: string;
  qty: number;
  note: string;
  issuedBy: string;
  receivedBy: string;
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

def num(raw):
    try:
        return float(raw)
    except Exception:
        return 0.0

out = []
for row in xlsx.load('/tmp/enshido-da.xlsx')['XUẤT  ĐÁ'][3:]:
    name = cell(row, 3)
    issued = day(cell(row, 1))
    if not name or not issued:
        continue
    out.append({
        'issuedAt': issued,
        'name': name,
        'unit': cell(row, 4),
        'qty': num(cell(row, 5)),
        'note': cell(row, 9),
        'issuedBy': cell(row, 10),
        'receivedBy': cell(row, 11),
    })
print(json.dumps(out))
`,
  ]).toString();
  return JSON.parse(json) as Row[];
}

async function main() {
  const all = readSheet();
  const rows = all
    .filter((row) => row.issuedAt >= FROM_DATE)
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  console.log(`Sheet có ${all.length} dòng, từ ${FROM_DATE} lấy ${rows.length} dòng.`);

  const warehouse = await prisma.warehouse.findUniqueOrThrow({
    where: { code: WAREHOUSE_CODE },
    select: { id: true, name: true },
  });

  const [materials, units, last] = await Promise.all([
    prisma.material.findMany({
      where: { warehouseId: warehouse.id },
      select: { id: true, sku: true, name: true, unitId: true },
    }),
    prisma.unit.findMany({ select: { id: true, name: true } }),
    prisma.stockOutbound.aggregate({
      where: { warehouseId: warehouse.id },
      _max: { sortOrder: true },
    }),
  ]);
  const materialBy = new Map(materials.map((m) => [norm(m.name), m]));
  const unitBy = new Map(units.map((u) => [norm(u.name), u]));

  let sortOrder = (last._max.sortOrder ?? 0) + 1;
  let created = 0;
  const missing = new Map<string, number>();

  for (const row of rows) {
    const material = materialBy.get(norm(row.name));
    if (!material) {
      missing.set(row.name, (missing.get(row.name) ?? 0) + 1);
      continue;
    }
    const unit = unitBy.get(norm(row.unit));

    if (!DRY_RUN) {
      await prisma.stockOutbound.create({
        data: {
          warehouseId: warehouse.id,
          materialId: material.id,
          sortOrder: sortOrder++,
          issuedAt: new Date(`${row.issuedAt}T09:00:00+07:00`),
          name: material.name,
          sku: material.sku,
          unitId: unit?.id ?? material.unitId,
          unitName: unit?.name ?? row.unit,
          qty: new Prisma.Decimal(row.qty),
          // Đơn giá tồn / đơn giá nhập / thành tiền để trống theo yêu cầu.
          note: row.note || null,
          issuedBy: row.issuedBy || null,
          receivedBy: row.receivedBy || null,
          // Seed lịch sử: tồn kho đá đã trừ số xuất này nên không trừ lần nữa.
          applyToStock: false,
        },
      });
    }
    created++;
  }

  if (missing.size) {
    console.log(`\nKhông khớp tên NVL (${missing.size} tên):`);
    for (const [name, count] of [...missing].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}x  ${name}`);
    }
  }
  console.log(
    `\n${DRY_RUN ? '[DRY RUN] sẽ tạo' : 'Đã tạo'} ${created}/${rows.length} phiếu xuất ở ${warehouse.name}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
