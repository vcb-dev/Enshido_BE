import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InventoryService } from '../inventory/inventory.service';
import { ctStr, decStr } from '../util/money';
import {
  shrinkHold,
  splitReturnedCount,
  splitReturnedWeight,
  stoneReturnedCount,
  stoneUsedByHold,
} from './stage-math';

/** Đơn vị đếm theo viên — SL xuất làm tròn ra viên. */
export const STONE_COUNT_UNITS = new Set(['viên', 'vien']);

export const isCountUnit = (unitName: string) =>
  STONE_COUNT_UNITS.has(unitName.trim().toLowerCase());

/**
 * Kiểm tra còn đủ đá để giữ chỗ: tồn trừ phiếu xuất nháp đang mở của mọi phiếu (kể cả phiếu này). Đọc tồn
 * khoá dòng tồn của mã nên hai lần cấp cùng mã chạy nối tiếp, không giữ trùng.
 */
export async function assertStoneFree(
  tx: Prisma.TransactionClient,
  inventory: InventoryService,
  material: { id: string; name: string },
  qty: Prisma.Decimal,
) {
  const onHand = await inventory.stockOnHand(tx, material.id);
  // Giữ chỗ = tổng phiếu xuất nháp đang mở của mã.
  const heldQty = await inventory.heldQty(tx, material.id);
  const free = onHand.sub(heldQty);
  if (qty.gt(free)) {
    throw new BadRequestException(
      `${material.name}: còn ${decStr(free)} (tồn ${decStr(onHand)}, đang giữ cho phiếu khác ${decStr(heldQty)}) — không cấp ${decStr(qty)}`,
    );
  }
}

type HoldForReturn = {
  id: string;
  materialId: string;
  stoneCount: number | null;
  weight: Prisma.Decimal | null;
  material: { name: string };
};

/**
 * Thủ kho nhận lại túi đá thợ trả giữa khâu (đổi size): chia TL túi trả cho các dòng đang giữ
 * cùng mã (dòng cấp cuối trước), mỗi dòng thu nhỏ theo tỷ lệ TL — phần trả nhả khỏi giữ chỗ.
 */
export function planEarlyReturn<
  H extends HoldForReturn & { qty: Prisma.Decimal },
>(holds: readonly H[], weight: Prisma.Decimal, countUnit: boolean) {
  const weighed = holds.filter(
    (hold) => hold.weight != null && hold.weight.gt(0),
  );
  if (weighed.length === 0) {
    throw new BadRequestException(
      'Mã đá này không có túi đang giữ (có cân gói) cho khâu — không nhận lại được',
    );
  }
  if (weight.lte(0)) {
    throw new BadRequestException('Nhập TL túi đá trả lại (ct)');
  }
  const total = weighed.reduce(
    (sum, hold) => sum.add(hold.weight!),
    new Prisma.Decimal(0),
  );
  if (weight.gt(total)) {
    throw new BadRequestException(
      `${weighed[0].material.name}: TL trả ${ctStr(weight)} nhiều hơn TL đang giữ ${ctStr(total)}`,
    );
  }
  const split = splitReturnedWeight(
    weighed.map((hold) => ({ id: hold.id, weight: hold.weight! })),
    weight,
  );
  return weighed
    .filter((hold) => split.get(hold.id)?.gt(0))
    .map((hold) => ({
      hold,
      ...shrinkHold(
        { qty: hold.qty, stoneCount: hold.stoneCount, weight: hold.weight! },
        split.get(hold.id)!,
        countUnit,
      ),
      returnedWeight: split.get(hold.id)!,
    }));
}

/**
 * QC nhận lại khâu Vào đá: chia TL gói đá thừa theo mã cho từng dòng đã cấp (trừ từ dòng cuối
 * ngược lên), quy ra số viên thừa theo tỷ lệ TL. Dòng cũ không cân gói thì chia số viên QC đếm.
 * Trả về giá trị ghi cho từng dòng và tổng số viên / TL thừa của khâu.
 */
export function planStoneReturn(
  holds: readonly HoldForReturn[],
  returnedStones: readonly {
    materialId: string;
    weight: string;
    count?: number | null;
  }[],
  legacyReturnedCount: number | null,
) {
  const weighed = holds.filter(
    (hold) => hold.weight != null && hold.weight.gt(0),
  );
  const legacy = holds.filter((hold) => !weighed.includes(hold));
  const seen = new Set<string>();
  const back = new Map<string, Prisma.Decimal>();
  /** Số viên thừa QC đếm, đã chia về từng dòng cấp của mã. */
  const backCount = new Map<string, number>();
  for (const line of returnedStones) {
    if (seen.has(line.materialId)) {
      throw new BadRequestException('Mỗi mã đá thừa chỉ nhập một dòng');
    }
    seen.add(line.materialId);
    const group = weighed.filter((hold) => hold.materialId === line.materialId);
    if (group.length === 0) {
      throw new BadRequestException(
        'Mã đá thừa không có trong số đá đã cấp (có cân gói) cho khâu này',
      );
    }
    const weight = new Prisma.Decimal(line.weight);
    const total = group.reduce(
      (sum, hold) => sum.add(hold.weight!),
      new Prisma.Decimal(0),
    );
    if (weight.gt(total)) {
      throw new BadRequestException(
        `${group[0].material.name}: TL gói thừa ${ctStr(weight)} nhiều hơn TL đã cấp ${ctStr(total)}`,
      );
    }
    const split = splitReturnedWeight(
      group.map((hold) => ({ id: hold.id, weight: hold.weight! })),
      weight,
    );
    for (const [id, value] of split) back.set(id, value);
    if (line.count != null) {
      const counted = group.filter((hold) => hold.stoneCount != null);
      const total = counted.reduce((sum, hold) => sum + hold.stoneCount!, 0);
      if (counted.length === 0) {
        throw new BadRequestException(
          `${group[0].material.name}: đá cấp theo ct, không có số viên — chỉ nhập TL gói thừa`,
        );
      }
      if (line.count > total) {
        throw new BadRequestException(
          `${group[0].material.name}: số viên thừa ${line.count} nhiều hơn số viên đã cấp ${total}`,
        );
      }
      if (line.count > 0 && weight.lte(0)) {
        throw new BadRequestException(
          `${group[0].material.name}: có viên thừa thì phải cân TL gói thừa`,
        );
      }
      for (const [id, value] of splitReturnedCount(
        counted.map((hold) => ({
          id: hold.id,
          stoneCount: hold.stoneCount!,
          returnedWeight: split.get(hold.id) ?? new Prisma.Decimal(0),
        })),
        line.count,
      )) {
        backCount.set(id, value);
      }
    }
  }

  const legacyCount = legacyReturnedCount ?? 0;
  const legacyTotal = legacy.reduce(
    (sum, hold) => sum + (hold.stoneCount ?? 0),
    0,
  );
  if (legacyCount > legacyTotal) {
    throw new BadRequestException(
      legacyTotal === 0
        ? 'Đá cấp cho khâu này đã cân gói — nhập TL gói đá thừa theo mã thay cho số viên'
        : `Đá trả lại (${legacyCount} viên) nhiều hơn số đá cấp chưa cân gói (${legacyTotal} viên)`,
    );
  }
  const legacyUsed = stoneUsedByHold(
    legacy.map((hold) => ({ id: hold.id, stoneCount: hold.stoneCount ?? 0 })),
    legacyCount,
  );

  const updates = holds.map((hold) => {
    if (weighed.includes(hold)) {
      const returnedWeight = back.get(hold.id) ?? new Prisma.Decimal(0);
      return {
        id: hold.id,
        returnedWeight,
        // QC đếm số viên thừa thì lấy số đó; không thì suy theo tỷ lệ TL gói thừa.
        returnedCount:
          backCount.get(hold.id) ?? stoneReturnedCount(hold, returnedWeight),
      };
    }
    const count = hold.stoneCount ?? 0;
    return {
      id: hold.id,
      returnedWeight: null,
      returnedCount: count - (legacyUsed.get(hold.id) ?? count),
    };
  });
  // Đá tính theo ct / g không đếm viên: số viên trả chỉ cộng các dòng có số viên.
  const counted = updates.filter((item) => item.returnedCount != null);
  return {
    updates,
    returnedStoneCount: counted.length
      ? counted.reduce((sum, item) => sum + (item.returnedCount ?? 0), 0)
      : null,
    returnedWeight: updates.reduce(
      (sum, item) => sum.add(item.returnedWeight ?? 0),
      new Prisma.Decimal(0),
    ),
  };
}

/** TL gói đá lúc cấp — bắt buộc, là mốc chia tỷ lệ khi QC cân gói thừa. */
export function packWeightOf(weight: string | null | undefined) {
  const value = weight ? new Prisma.Decimal(weight) : null;
  if (!value || value.lte(0)) {
    throw new BadRequestException(
      'Cân cả gói đá và nhập TL gói (ct) — QC cân gói thừa để tính đá đã dùng',
    );
  }
  return value;
}
