import { Prisma } from '@prisma/client';

type SilverWeights = {
  handedSilverWeight: Prisma.Decimal | null;
  returnedSilverWeight: Prisma.Decimal | null;
  btpRecoveredWeight: Prisma.Decimal | null;
  silverRecoveredWeight: Prisma.Decimal | null;
};

/** Hao hụt bạc của một khâu = TL bạc giao − TL bạc nhận lại − BTP thu hồi − bạc thu hồi. */
export function silverLossOf(entry: SilverWeights): Prisma.Decimal | null {
  if (entry.handedSilverWeight == null || entry.returnedSilverWeight == null) {
    return null;
  }
  const zero = new Prisma.Decimal(0);
  return entry.handedSilverWeight
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
