import { Prisma, ProductionStage } from '@prisma/client';

/** Hệ số tính tiền trên TL bạc: (TL sau Xi − TL đá) × 0,95. */
export const BILLED_WEIGHT_RATIO = new Prisma.Decimal('0.95');

export type WeightStageEntry = {
  stage: ProductionStage;
  subTicketId: string | null;
  attempt: number;
  returnedAt: Date | null;
  handedQty: number | null;
  returnedQty: number | null;
  returnedSilverWeight: Prisma.Decimal | null;
  stoneWeight: Prisma.Decimal | null;
};

/** Lần QC nhận lại gần nhất của khâu, mỗi phiếu (mẹ / con) một lần. */
function latestReturned(
  entries: readonly WeightStageEntry[],
  stage: ProductionStage,
) {
  const byTicket = new Map<string, WeightStageEntry>();
  for (const entry of entries) {
    if (entry.stage !== stage || entry.returnedAt == null) continue;
    const key = entry.subTicketId ?? '';
    const current = byTicket.get(key);
    if (!current || entry.attempt > current.attempt) byTicket.set(key, entry);
  }
  return [...byTicket.values()];
}

/**
 * TL bạc một chiếc sau Xi (g): TL QC cân lại ở Xi trừ đá gắn thật ở Vào đá, cả hai chia theo
 * từng chiếc vì phiếu xuất có thể chỉ lấy một phần đơn. Đơn có đá (`hasStone`) mà chưa ghi đá
 * gắn, hoặc chưa cân ở Xi, thì null — người lập nhập TL tay.
 */
export function netGramPerUnit(
  entries: readonly WeightStageEntry[],
  hasStone: boolean,
): Prisma.Decimal | null {
  const plated = latestReturned(entries, ProductionStage.PLATING);
  let platedWeight = new Prisma.Decimal(0);
  let platedQty = 0;
  for (const entry of plated) {
    if (entry.returnedSilverWeight == null) return null;
    platedWeight = platedWeight.add(entry.returnedSilverWeight);
    platedQty += entry.returnedQty ?? 0;
  }
  if (platedQty <= 0) return null;
  let perUnit = platedWeight.div(platedQty);

  if (hasStone) {
    const set = latestReturned(entries, ProductionStage.STONE_SETTING);
    let stoneWeight = new Prisma.Decimal(0);
    let stoneQty = 0;
    for (const entry of set) {
      if (entry.stoneWeight == null) return null;
      stoneWeight = stoneWeight.add(entry.stoneWeight);
      stoneQty += entry.handedQty ?? entry.returnedQty ?? 0;
    }
    if (stoneQty <= 0) return null;
    perUnit = perUnit.sub(stoneWeight.div(stoneQty));
  }

  // Làm tròn 4 số như cột TL trong DB, để FE tính lại ra đúng số gram server lưu.
  return perUnit.gt(0) ? perUnit.toDecimalPlaces(4) : null;
}

/** TL tính tiền (g) của `qty` chiếc = TL bạc một chiếc × SL × 0,95, làm tròn 2 số. */
export function gramOf(
  gramPerUnit: Prisma.Decimal | null,
  qty: number,
): Prisma.Decimal | null {
  if (gramPerUnit == null) return null;
  return gramPerUnit
    .mul(qty)
    .mul(BILLED_WEIGHT_RATIO)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export type InvoiceParts = {
  weightGram: Prisma.Decimal | null;
  materialUnitPrice: Prisma.Decimal | null;
  laborAmount: Prisma.Decimal | null;
  stoneAmount: Prisma.Decimal | null;
  otherAmount: Prisma.Decimal | null;
};

/** Đủ TL + bốn khoản người lập nhập thì dòng mới in được. */
export function invoiceComplete(parts: InvoiceParts) {
  return (
    parts.weightGram != null &&
    parts.materialUnitPrice != null &&
    parts.laborAmount != null &&
    parts.stoneAmount != null &&
    parts.otherAmount != null
  );
}

/** Thành tiền dòng = TL (g) × đơn giá NL (theo gram) + tiền công + tiền đá + chi phí khác; khoản trống tính 0. */
export function invoiceAmount(parts: InvoiceParts) {
  const material = (parts.weightGram ?? new Prisma.Decimal(0))
    .mul(parts.materialUnitPrice ?? 0)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return material
    .add(parts.laborAmount ?? 0)
    .add(parts.stoneAmount ?? 0)
    .add(parts.otherAmount ?? 0);
}
