import {
  MaterialRequestKind,
  MaterialRequestStatus,
  Prisma,
} from '@prisma/client';

type SilverWeights = {
  handedSilverWeight: Prisma.Decimal | null;
  /** Đá gắn thêm ở khâu Vào đá; khâu khác để trống. */
  stoneWeight?: Prisma.Decimal | null;
  returnedSilverWeight: Prisma.Decimal | null;
  btpRecoveredWeight: Prisma.Decimal | null;
  silverRecoveredWeight: Prisma.Decimal | null;
};

type StoneCounts = {
  handedStoneCount: number | null;
  stoneCount: number | null;
  returnedStoneCount: number | null;
  returnedAt: Date | null;
};

/** Các trường của một yêu cầu xuất NVL mà việc tính đầu vào khâu cần tới. */
export type IssuedRequest = {
  status: MaterialRequestStatus;
  kind: MaterialRequestKind;
  issuedWeight: Prisma.Decimal | null;
  issuedStoneCount: number | null;
};

const zero = () => new Prisma.Decimal(0);

/** NVL đã xuất thêm trong khâu: gram bạc / kim loại, số viên + TL đá. Yêu cầu chưa xuất không tính. */
export function issuedOf(requests: readonly IssuedRequest[] = []) {
  let metal = zero();
  let stones = 0;
  let stoneWeight = zero();
  for (const request of requests) {
    if (request.status !== MaterialRequestStatus.ISSUED) continue;
    if (request.kind === MaterialRequestKind.METAL) {
      metal = metal.add(request.issuedWeight ?? 0);
    } else if (request.kind === MaterialRequestKind.STONE) {
      stones += request.issuedStoneCount ?? 0;
      stoneWeight = stoneWeight.add(request.issuedWeight ?? 0);
    }
  }
  return { metal, stones, stoneWeight };
}

/**
 * Bạc vào khâu = TL giao lúc nhận việc + bạc xuất thêm trong khâu. Chưa cân lúc giao mà cũng
 * chưa xuất gì thì null — không có mốc để tính hao hụt.
 */
export function silverInOf(
  entry: Pick<SilverWeights, 'handedSilverWeight'>,
  issuedMetal: Prisma.Decimal = zero(),
): Prisma.Decimal | null {
  if (entry.handedSilverWeight == null && issuedMetal.isZero()) return null;
  return (entry.handedSilverWeight ?? zero()).add(issuedMetal);
}

/**
 * Hao hụt bạc của một khâu = (bạc vào khâu + TL đá gắn thêm) − TL cân lại − BTP thu hồi −
 * bạc thu hồi. Bạc vào khâu gồm cả phần thợ xin xuất thêm. Khâu Vào đá cân cả cụm bạc + đá
 * nên phải cộng đá vào vế giao; đá tự nó không hao nên không ảnh hưởng kết quả.
 */
export function silverLossOf(
  entry: SilverWeights,
  issuedMetal: Prisma.Decimal = zero(),
): Prisma.Decimal | null {
  const silverIn = silverInOf(entry, issuedMetal);
  if (silverIn == null || entry.returnedSilverWeight == null) return null;
  return silverIn
    .add(entry.stoneWeight ?? 0)
    .sub(entry.returnedSilverWeight)
    .sub(entry.btpRecoveredWeight ?? 0)
    .sub(entry.silverRecoveredWeight ?? 0);
}

/** % hao hụt trên bạc vào khâu, 2 chữ số. */
export function lossPercentOf(
  loss: Prisma.Decimal | null,
  base: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (loss == null || base == null || base.lte(0)) return null;
  return loss.div(base).mul(100).toDecimalPlaces(2);
}

/**
 * Đá mất ở khâu (viên) = đá phát lúc giao + đá xuất thêm − đá gắn lên − đá trả lại. Chỉ tính
 * khi KCS đã nhận lại và khâu có phát đá.
 */
export function stoneLossOf(entry: StoneCounts, issuedStones = 0) {
  const stonesIn = (entry.handedStoneCount ?? 0) + issuedStones;
  if (!entry.returnedAt || stonesIn === 0) {
    return { stonesIn: stonesIn || null, loss: null };
  }
  return {
    stonesIn,
    loss: stonesIn - (entry.stoneCount ?? 0) - (entry.returnedStoneCount ?? 0),
  };
}

/** Bạc + BTP thu hồi của một khâu (gram). */
export function recoveredOf(entry: SilverWeights): Prisma.Decimal {
  return (entry.btpRecoveredWeight ?? zero()).add(
    entry.silverRecoveredWeight ?? zero(),
  );
}
