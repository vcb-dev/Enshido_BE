import { readFileSync } from 'node:fs';
import { MaterialClass, PrismaClient } from '@prisma/client';
import { allocateMaterialSku } from '../src/util/material-sku';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

const WAREHOUSE_CODE = 'nvl-tieu-hao';
const DRY_RUN = process.env.DRY_RUN === '1';

/** Cột trên sheet "BẢNG NXT MỚI"; dữ liệu bắt đầu từ dòng 4. */
const COL = {
  name: 1,
  unit: 2,
  stockQty: 6,
  group: 8,
} as const;

const UNIT_BY_NAME: Record<string, string> = {
  chiếc: 'chiec',
  cái: 'cai',
  hộp: 'hop',
  lọ: 'lo',
  bó: 'bo-vat-lieu',
  bộ: 'bo',
  chai: 'chai',
  kg: 'kg',
  lít: 'lit',
  m: 'met',
  túi: 'tui',
  đôi: 'doi',
};

const TYPE_BY_GROUP: Record<string, string> = {
  ccdc: 'ccdc',
  'nvl phụ': 'nvl-phu',
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

const norm = (raw: string) =>
  raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

async function main() {
  const data = parseCsv(
    readFileSync('prisma/data/nxt-nvl-tieu-hao.csv', 'utf8'),
  )
    .slice(3)
    .filter((row) => row[COL.name]?.trim());
  console.log(`Đọc ${data.length} dòng NVL tiêu hao từ file.`);

  const warehouse = await prisma.warehouse.findUniqueOrThrow({
    where: { code: WAREHOUSE_CODE },
    select: { id: true, name: true },
  });

  const [units, types] = await Promise.all([
    prisma.unit.findMany({ select: { id: true, code: true } }),
    prisma.materialType.findMany({ select: { id: true, code: true } }),
  ]);
  const unitBy = new Map(units.map((u) => [u.code, u.id]));
  const typeBy = new Map(types.map((t) => [t.code, t.id]));

  let imported = 0;
  let totalQty = 0;
  const clamped: string[] = [];
  const skipped: string[] = [];

  for (const [index, row] of data.entries()) {
    const name = row[COL.name].trim();

    const unitId = unitBy.get(UNIT_BY_NAME[norm(row[COL.unit])] ?? '');
    if (!unitId) {
      skipped.push(`${name} — đơn vị "${row[COL.unit]}"`);
      continue;
    }

    const materialTypeId = typeBy.get(TYPE_BY_GROUP[norm(row[COL.group])] ?? '');
    if (!materialTypeId) {
      skipped.push(`${name} — nhóm "${row[COL.group]}"`);
      continue;
    }

    // Vài dòng âm vì sổ ghi xuất nhiều hơn nhập — giữ nguyên theo số liệu gốc.
    const qty = num(row[COL.stockQty]) ?? 0;
    if (qty < 0) clamped.push(`${name}: ${qty}`);
    totalQty += qty;

    if (!DRY_RUN) {
      await prisma.$transaction(async (tx) => {
        const material = await tx.material.create({
          data: {
            warehouseId: warehouse.id,
            sku: await allocateMaterialSku(tx, WAREHOUSE_CODE),
            name,
            unitId,
            materialTypeId,
            classification: MaterialClass.RAW_MATERIAL,
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
    }
    imported++;
  }

  if (clamped.length) {
    console.log(`\nTồn âm giữ nguyên (${clamped.length} dòng):`);
    for (const line of clamped) console.log(`  ${line}`);
  }
  if (skipped.length) {
    console.log(`\nBỏ qua (${skipped.length} dòng):`);
    for (const line of skipped) console.log(`  ${line}`);
  }
  console.log(
    `\n${DRY_RUN ? '[DRY RUN] sẽ tạo' : 'Đã tạo'} ${imported}/${data.length} vật tư ở ${warehouse.name}, tổng SL tồn đầu kỳ ${totalQty.toLocaleString('vi-VN')}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
