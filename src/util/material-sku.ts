import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const MATERIAL_SKU_DIGITS = 5;
export const MATERIAL_SKU_RE = /^\d{5}$/;
const MATERIAL_SKU_MAX = 99_999;

export function formatMaterialSku(n: number): string {
  return String(n).padStart(MATERIAL_SKU_DIGITS, '0');
}

type SkuDb = {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Promise<T>;
};

/** Mã NVL 5 chữ số, không trùng trong toàn bộ bảng materials. */
export async function allocateMaterialSku(db: SkuDb): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ max: number | null }>>(
    Prisma.sql`SELECT MAX(sku::int) AS max FROM materials WHERE sku ~ '^[0-9]{5}$'`,
  );
  const next = (row?.max ?? 0) + 1;
  if (next > MATERIAL_SKU_MAX) {
    throw new BadRequestException('Đã hết mã NVL 5 chữ số');
  }
  return formatMaterialSku(next);
}
