import { readFileSync } from 'node:fs';
import { MaterialClass, MetalKind, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

const WAREHOUSE_CODE = 'nvl-chinh';
/** Vị trí trong file Excel bỏ tiền tố zone (1A1), kho NVL chính đánh đủ zone (A1A1). */
const LOCATION_ZONE = 'A';

/** Cột trong sheet "TỒN KHO ĐÁ"; dữ liệu bắt đầu từ dòng 8. */
const COL = {
  location: 1,
  sku: 2,
  shape: 3,
  color: 4,
  name: 5,
  unit: 6,
  stockQty: 13,
  stoneType: 15,
} as const;

/** Gõ nhầm / viết tắt trong file, quy về đúng tên trong danh mục màu. */
const COLOR_FIXES: Record<string, string> = {
  'xang duong': 'Xanh dương',
  'mau trang': 'Trắng',
  vang: 'Vàng',
};

const UNIT_BY_NAME: Record<string, string> = {
  viên: 'vien',
  ct: 'ct',
  bảng: 'bang',
  bộ: 'bo',
};

const STONE_TYPE_BY_NAME: Record<string, string> = {
  'đá moiss': 'da-moiss',
  'đá cz': 'da-cz',
  'đá dz': 'da-dz',
  'đá quý khác': 'da-quy-khac',
  'đá thường': 'da-thuong',
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') (cell += '"'), i++;
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') (row.push(cell), (cell = ''));
    else if (char === '\n') (row.push(cell), rows.push(row), (row = []), (cell = ''));
    else if (char !== '\r') cell += char;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

/** "1.234,50" → 1234.5 */
function num(raw: string): number | null {
  const value = Number(raw.trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

const norm = (raw: string) => raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Bỏ dấu để so khớp lỗi gõ ("Vảng" → "vang"). */
const bare = (raw: string) =>
  norm(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');

function slug(raw: string) {
  return bare(raw)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function main() {
  const rows = parseCsv(readFileSync('prisma/data/ton-kho-da.csv', 'utf8'));
  const data = rows
    .slice(7)
    .filter((row) => row.slice(0, 7).some((cell) => cell.trim()))
    .filter((row) => row[COL.name]?.trim());
  console.log(`Đọc ${data.length} dòng đá từ file.`);

  const warehouse = await prisma.warehouse.findUniqueOrThrow({
    where: { code: WAREHOUSE_CODE },
    select: { id: true, name: true },
  });

  const [units, types, shapes, colors, locations] = await Promise.all([
    prisma.unit.findMany({ select: { id: true, code: true } }),
    prisma.materialType.findMany({ select: { id: true, code: true } }),
    prisma.shape.findMany({ select: { id: true, name: true } }),
    prisma.color.findMany({ select: { id: true, name: true } }),
    prisma.warehouseLocation.findMany({
      where: { warehouseId: warehouse.id },
      select: { code: true },
    }),
  ]);
  const unitBy = new Map(units.map((u) => [u.code, u.id]));
  const typeBy = new Map(types.map((t) => [t.code, t.id]));
  const shapeBy = new Map(shapes.map((s) => [norm(s.name), s.id]));
  const colorBy = new Map(colors.map((c) => [norm(c.name), c.id]));
  const colorByBare = new Map(colors.map((c) => [bare(c.name), c.id]));
  const locationCodes = new Set(locations.map((l) => l.code));

  // Màu chưa có trong danh mục (Các màu, Dải màu, Hồng tím…) — thêm mới để không mất dữ liệu.
  const missingColors = new Map<string, string>();
  for (const row of data) {
    const raw = row[COL.color]?.trim();
    if (!raw) continue;
    const fixed = COLOR_FIXES[bare(raw)] ?? raw;
    if (colorBy.has(norm(fixed)) || colorByBare.has(bare(fixed))) continue;
    const name = fixed[0].toUpperCase() + fixed.slice(1).toLowerCase();
    missingColors.set(norm(name), name);
  }
  if (missingColors.size) {
    let sortOrder = colors.length;
    for (const name of missingColors.values()) {
      const created = await prisma.color.create({
        data: { code: slug(name), name, sortOrder: sortOrder++ },
        select: { id: true, name: true },
      });
      colorBy.set(norm(created.name), created.id);
      colorByBare.set(bare(created.name), created.id);
    }
    console.log(`Thêm ${missingColors.size} màu mới: ${[...missingColors.values()].join(', ')}`);
  }

  const warn = { shape: 0, color: 0, location: 0, unit: 0, type: 0 };
  let seq = 0;
  let imported = 0;
  let totalQty = 0;

  for (const [index, row] of data.entries()) {
    const name = row[COL.name].trim();

    const unitId = unitBy.get(UNIT_BY_NAME[norm(row[COL.unit])] ?? '');
    if (!unitId) {
      warn.unit++;
      console.warn(`  bỏ qua "${name}" — không nhận ra đơn vị "${row[COL.unit]}"`);
      continue;
    }

    const typeCode = STONE_TYPE_BY_NAME[norm(row[COL.stoneType] ?? '')];
    const materialTypeId = typeCode ? typeBy.get(typeCode) : undefined;
    if (!materialTypeId) warn.type++;

    const shapeId = shapeBy.get(norm(row[COL.shape] ?? ''));
    if (row[COL.shape]?.trim() && !shapeId) warn.shape++;

    const rawColor = row[COL.color]?.trim();
    const fixedColor = rawColor ? (COLOR_FIXES[bare(rawColor)] ?? rawColor) : '';
    const colorId = fixedColor
      ? (colorBy.get(norm(fixedColor)) ?? colorByBare.get(bare(fixedColor)))
      : undefined;
    if (rawColor && !colorId) warn.color++;

    // "1E5 ( hàng ko có chứng thư)" → chỉ lấy phần mã.
    const rawLocation = (row[COL.location] ?? '').trim().split('(')[0].trim();
    let locationCode: string | null = null;
    if (rawLocation) {
      const full = LOCATION_ZONE + rawLocation;
      if (locationCodes.has(full)) locationCode = full;
      else warn.location++;
    }

    const qty = num(row[COL.stockQty]) ?? 0;
    totalQty += qty;
    const workshopSku = row[COL.sku]?.trim();

    await prisma.$transaction(async (tx) => {
      const material = await tx.material.create({
        data: {
          warehouseId: warehouse.id,
          sku: `A${String(++seq).padStart(5, '0')}`,
          name,
          locationCode,
          unitId,
          materialTypeId: materialTypeId ?? null,
          shapeId: shapeId ?? null,
          colorId: colorId ?? null,
          classification: MaterialClass.RAW_MATERIAL,
          metalKind: MetalKind.STONE,
          note: workshopSku ? `Mã xưởng: ${workshopSku}` : null,
          sortOrder: index,
        },
        select: { id: true },
      });
      await tx.stockBalance.create({
        data: {
          warehouseId: warehouse.id,
          materialId: material.id,
          openingQty: qty,
          qty,
        },
      });
    });
    imported++;
  }

  console.log(`\nĐã tạo ${imported} vật tư vào ${warehouse.name}, tổng SL tồn ${totalQty.toLocaleString('vi-VN')}.`);
  console.log('Chưa map được:', warn);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
