import { Prisma } from '@prisma/client';

export function decStr(value: Prisma.Decimal | null | undefined): string {
  if (value == null) return '0';
  return value.toString();
}

export type AvailabilityCode = 'IN_STOCK' | 'LOW' | 'OUT_OF_STOCK';

export function availabilityOf(
  qty: Prisma.Decimal | string | number,
  reorderPoint: Prisma.Decimal | string | number,
): { code: AvailabilityCode; label: string } {
  const q = new Prisma.Decimal(qty);
  if (q.lte(0)) return { code: 'OUT_OF_STOCK', label: 'Hết hàng' };
  if (q.lt(new Prisma.Decimal(reorderPoint))) {
    return { code: 'LOW', label: 'Sắp hết hàng' };
  }
  return { code: 'IN_STOCK', label: 'Còn' };
}

export const CLASS_LABEL: Record<string, string> = {
  RAW_MATERIAL: 'Nguyên liệu',
  CONSUMABLE: 'Tiêu hao',
  SEMI_FINISHED: 'Bán thành phẩm',
};
