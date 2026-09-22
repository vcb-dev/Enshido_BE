import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dbTable } from '../prisma/database-url';

export const MATERIAL_SKU_DIGITS = 5;
export const MATERIAL_SKU_RE = /^[ABCD]\d{5}$/;
const MATERIAL_SKU_MAX = 99_999;

const SKU_PREFIX: Record<string, 'A' | 'B' | 'C' | 'D'> = {
  'nvl-chinh': 'A',
  'btp-cho-vao-da': 'B',
  'ban-thanh-pham': 'B',
  'thanh-pham': 'C',
  'nvl-tieu-hao': 'D',
};

export function skuPrefixOf(warehouseCode: string): 'A' | 'B' | 'C' | 'D' {
  return SKU_PREFIX[warehouseCode] ?? 'A';
}

export function formatMaterialSku(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(MATERIAL_SKU_DIGITS, '0')}`;
}

type SkuDb = {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Promise<T>;
};

/** Mã kho: chữ cái theo loại + 5 số, không trùng trong toàn bộ bảng materials. */
export async function allocateMaterialSku(
  db: SkuDb,
  warehouseCode: string,
): Promise<string> {
  const prefix = skuPrefixOf(warehouseCode);
  const pattern = `^${prefix}[0-9]{${MATERIAL_SKU_DIGITS}}$`;
  const [row] = await db.$queryRaw<Array<{ max: number | null }>>(
    Prisma.sql`SELECT MAX(SUBSTRING(sku FROM 2)::int) AS max FROM ${dbTable('materials')} WHERE sku ~ ${pattern}`,
  );
  const next = (row?.max ?? 0) + 1;
  if (next > MATERIAL_SKU_MAX) {
    throw new BadRequestException(`Đã hết mã ${prefix} + 5 chữ số`);
  }
  return formatMaterialSku(prefix, next);
}
