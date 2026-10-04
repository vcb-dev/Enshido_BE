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
  /** Nguội / Vào đá: nguyên liệu thừa S999. */
  scrapS999Weight?: Prisma.Decimal | null;
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
    .sub(entry.silverRecoveredWeight ?? 0)
    .sub(entry.scrapS999Weight ?? 0);
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
 * khi QC đã nhận lại và khâu có phát đá.
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
  return (entry.btpRecoveredWeight ?? zero())
    .add(entry.silverRecoveredWeight ?? zero())
    .add(entry.scrapS999Weight ?? zero());
}

/**
 * Chia số đá thợ trả lại cho các dòng đá đã cấp (trừ từ dòng cuối ngược lên) và trả về số viên
 * thực dùng của từng dòng = cấp − trả. Số viên dùng gồm cả đá gắn lên lẫn đá mất.
 */
export function stoneUsedByHold(
  holds: readonly { id: string; stoneCount: number }[],
  returnedStones: number,
): Map<string, number> {
  let toReturn = Math.max(0, returnedStones);
  const used = new Map<string, number>();
  for (const hold of [...holds].reverse()) {
    const back = Math.min(toReturn, hold.stoneCount);
    used.set(hold.id, hold.stoneCount - back);
    toReturn -= back;
  }
  return used;
}

/**
 * Chia TL gói đá thừa QC cân (một mã) cho các dòng cấp cùng mã: trừ từ dòng cấp cuối ngược
 * lên, mỗi dòng không quá TL gói đã cấp. Trả về TL thừa của từng dòng.
 */
export function splitReturnedWeight(
  holds: readonly { id: string; weight: Prisma.Decimal }[],
  returnedWeight: Prisma.Decimal,
): Map<string, Prisma.Decimal> {
  let left = Prisma.Decimal.max(returnedWeight, 0);
  const back = new Map<string, Prisma.Decimal>();
  for (const hold of [...holds].reverse()) {
    const take = Prisma.Decimal.min(left, hold.weight);
    back.set(hold.id, take);
    left = left.sub(take);
  }
  return back;
}

/**
 * Đá thừa của một dòng cấp quy theo tỷ lệ cân gói — không ai đếm từng viên:
 * viên thừa = viên cấp × TL thừa / TL cấp (làm tròn). Dòng cũ không cân thì dùng số viên QC đếm.
 */
export function stoneReturnedCount(
  hold: { stoneCount: number | null; weight: Prisma.Decimal | null },
  returnedWeight: Prisma.Decimal,
) {
  // Đá tính theo ct / g không đếm viên — chỉ có TL.
  if (hold.stoneCount == null) return null;
  if (!hold.weight || hold.weight.lte(0)) return 0;
  const ratio = Prisma.Decimal.min(returnedWeight.div(hold.weight), 1);
  return Math.min(
    hold.stoneCount,
    new Prisma.Decimal(hold.stoneCount)
      .mul(ratio)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber(),
  );
}

/**
 * SL xuất kho của một dòng cấp lúc thủ kho xác nhận. Dòng có cân gói: SL cấp × (TL cấp − TL
 * thừa) / TL cấp. Dòng cũ không cân: theo số viên thừa. Mã tính theo viên làm tròn ra viên.
 */
export function stoneUsedQty(
  hold: {
    qty: Prisma.Decimal;
    stoneCount: number | null;
    weight: Prisma.Decimal | null;
    returnedWeight: Prisma.Decimal | null;
    returnedCount: number | null;
  },
  countUnit: boolean,
) {
  const used =
    hold.weight && hold.weight.gt(0) && hold.returnedWeight != null
      ? hold.qty.mul(hold.weight.sub(hold.returnedWeight)).div(hold.weight)
      : hold.stoneCount
        ? hold.qty
            .mul(
              hold.stoneCount -
                Math.min(hold.returnedCount ?? 0, hold.stoneCount),
            )
            .div(hold.stoneCount)
        : hold.qty;
  const qty = countUnit
    ? used.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    : used.toDecimalPlaces(4);
  return Prisma.Decimal.max(qty, 0);
}

/**
 * Thợ trả túi đá giữa khâu (đổi size): phần trả theo tỷ lệ TL gói được nhả khỏi giữ chỗ ngay.
 * Trả về phần còn giữ (SL / viên / TL) và phần đã trả. Mã tính theo viên làm tròn ra viên.
 */
export function shrinkHold(
  hold: {
    qty: Prisma.Decimal;
    stoneCount: number | null;
    weight: Prisma.Decimal;
  },
  returnedWeight: Prisma.Decimal,
  countUnit: boolean,
) {
  const ratio = Prisma.Decimal.min(returnedWeight.div(hold.weight), 1);
  const rawQty = hold.qty.mul(ratio);
  const returnedQty = Prisma.Decimal.min(
    countUnit
      ? rawQty.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      : rawQty.toDecimalPlaces(4),
    hold.qty,
  );
  const returnedCount = stoneReturnedCount(hold, returnedWeight);
  return {
    qty: hold.qty.sub(returnedQty),
    stoneCount:
      hold.stoneCount != null ? hold.stoneCount - (returnedCount ?? 0) : null,
    weight: hold.weight.sub(Prisma.Decimal.min(returnedWeight, hold.weight)),
    returnedQty,
    returnedCount,
  };
}
