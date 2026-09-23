import { Prisma } from '@prisma/client';

type SilverWeights = {
  handedSilverWeight: Prisma.Decimal | null;
  /** Đá gắn thêm ở khâu Vào đá; khâu khác để trống. */
  stoneWeight?: Prisma.Decimal | null;
  returnedSilverWeight: Prisma.Decimal | null;
  btpRecoveredWeight: Prisma.Decimal | null;
  silverRecoveredWeight: Prisma.Decimal | null;
};

/**
 * Hao hụt bạc của một khâu = (TL bạc giao + TL đá gắn thêm) − TL cân lại − BTP thu hồi −
 * bạc thu hồi. Khâu Vào đá cân cả cụm bạc + đá nên phải cộng đá vào vế giao; đá tự nó không
 * hao nên không ảnh hưởng kết quả, chỉ để hai vế cùng gồm đá.
 */
export function silverLossOf(entry: SilverWeights): Prisma.Decimal | null {
  if (entry.handedSilverWeight == null || entry.returnedSilverWeight == null) {
    return null;
  }
  const zero = new Prisma.Decimal(0);
  return entry.handedSilverWeight
    .add(entry.stoneWeight ?? zero)
    .sub(entry.returnedSilverWeight)
    .sub(entry.btpRecoveredWeight ?? zero)
    .sub(entry.silverRecoveredWeight ?? zero);
}

/** Bạc + BTP thu hồi của một khâu (gram). */
export function recoveredOf(entry: SilverWeights): Prisma.Decimal {
  const zero = new Prisma.Decimal(0);
  return (entry.btpRecoveredWeight ?? zero).add(
    entry.silverRecoveredWeight ?? zero,
  );
}
