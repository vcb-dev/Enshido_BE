import { LossStage, Prisma } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Xem tối đa ngần này tuần một lần (so sánh nhiều tuần liền nhau). */
export const LOSS_REPORT_MAX_WEEKS = 26;

/** Thứ tự khâu trên báo cáo, theo luồng sản xuất. */
export const LOSS_STAGE_ORDER: LossStage[] = [
  LossStage.CASTING,
  LossStage.FILING,
  LossStage.STONE_SETTING,
  LossStage.ENGRAVING,
  LossStage.POLISHING,
  LossStage.PLATING,
];

/** Thứ Hai (giờ Việt Nam) của tuần chứa ngày `key` (YYYY-MM-DD). */
export function weekStartKey(key: string) {
  const day = new Date(`${key}T00:00:00Z`);
  // getUTCDay: 0 = Chủ nhật → lùi 6 ngày; thứ Hai lùi 0.
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

/** Tuần (thứ Hai) của một thời điểm theo giờ Việt Nam. */
export function weekOf(date: Date) {
  return weekStartKey(
    new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10),
  );
}

export function addDaysKey(key: string, days: number) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Các tuần (thứ Hai) từ tuần chứa `from` tới tuần chứa `to`, cũ trước. */
export function weekKeys(from: string, to: string) {
  const first = weekStartKey(from);
  const last = weekStartKey(to);
  const weeks: string[] = [];
  for (let key = first; key <= last; key = addDaysKey(key, 7)) {
    weeks.push(key);
  }
  return weeks;
}

/** Mốc 00:00 giờ Việt Nam của ngày `key`. */
export function vnStart(key: string) {
  return new Date(Date.parse(`${key}T00:00:00Z`) - VN_OFFSET_MS);
}

const zero = () => new Prisma.Decimal(0);

/**
 * Một lượt khâu (hoặc một phiếu đúc) đã chốt số — các vế theo cột tab BÁO CÁO:
 * giao = hàng trả + BTP thu hồi + NVL thu hồi + hao hụt.
 */
export type LossItem = {
  week: string;
  workerKey: string;
  workerUserId: string | null;
  workerName: string;
  stage: LossStage;
  /** Mã phiếu thợ (DH…-n) hoặc mã phiếu đúc. */
  ticketCode: string;
  attempt: number;
  confirmedAt: Date;
  qty: number;
  inGram: Prisma.Decimal;
  productGram: Prisma.Decimal;
  btpGram: Prisma.Decimal;
  nvlGram: Prisma.Decimal;
};

type Sums = {
  tickets: number;
  qty: number;
  inGram: Prisma.Decimal;
  productGram: Prisma.Decimal;
  btpGram: Prisma.Decimal;
  nvlGram: Prisma.Decimal;
};

const emptySums = (): Sums => ({
  tickets: 0,
  qty: 0,
  inGram: zero(),
  productGram: zero(),
  btpGram: zero(),
  nvlGram: zero(),
});

function addItem(sums: Sums, item: LossItem) {
  sums.tickets += 1;
  sums.qty += item.qty;
  sums.inGram = sums.inGram.add(item.inGram);
  sums.productGram = sums.productGram.add(item.productGram);
  sums.btpGram = sums.btpGram.add(item.btpGram);
  sums.nvlGram = sums.nvlGram.add(item.nvlGram);
}

/** % trên TL giao, 2 chữ số. Chưa giao gì thì không có %. */
export function percentOf(part: Prisma.Decimal, base: Prisma.Decimal) {
  if (base.lte(0)) return null;
  return part.div(base).mul(100).toDecimalPlaces(2);
}

export type ScrapSum = {
  week: string;
  workerKey: string;
  workerUserId: string | null;
  workerName: string;
  weightGram: Prisma.Decimal;
};

export type LossLimitMap = Map<LossStage, Prisma.Decimal>;

/**
 * Gom các lượt khâu thành dòng thợ × khâu và dòng tổng của thợ theo từng tuần.
 *
 * Mạt vụn thợ trả cuối tuần một cục cho cả tuần, không tách được theo khâu — nên chỉ trừ ở dòng
 * tổng của thợ; dòng khâu là hao hụt trước khi trừ mạt. Mức cho phép của dòng tổng = bình quân
 * mức từng khâu theo TL giao; có khâu chưa đặt mức thì dòng tổng cũng không có mức.
 */
export function buildLossReport(
  items: readonly LossItem[],
  scraps: readonly ScrapSum[],
  limits: LossLimitMap,
) {
  type Worker = {
    week: string;
    workerKey: string;
    workerUserId: string | null;
    workerName: string;
    sums: Sums;
    stages: Map<LossStage, Sums>;
    scrapGram: Prisma.Decimal;
  };
  const workers = new Map<string, Worker>();
  const workerOf = (row: {
    week: string;
    workerKey: string;
    workerUserId: string | null;
    workerName: string;
  }) => {
    const key = `${row.week}|${row.workerKey}`;
    let worker = workers.get(key);
    if (!worker) {
      worker = {
        week: row.week,
        workerKey: row.workerKey,
        workerUserId: row.workerUserId,
        workerName: row.workerName,
        sums: emptySums(),
        stages: new Map(),
        scrapGram: zero(),
      };
      workers.set(key, worker);
    }
    return worker;
  };

  for (const item of items) {
    const worker = workerOf(item);
    addItem(worker.sums, item);
    const stage = worker.stages.get(item.stage) ?? emptySums();
    addItem(stage, item);
    worker.stages.set(item.stage, stage);
  }
  for (const scrap of scraps) {
    const worker = workerOf(scrap);
    worker.scrapGram = worker.scrapGram.add(scrap.weightGram);
  }

  const rows = [...workers.values()].map((worker) => {
    const stages = LOSS_STAGE_ORDER.filter((stage) =>
      worker.stages.has(stage),
    ).map((stage) => {
      const sums = worker.stages.get(stage)!;
      const returned = sums.productGram.add(sums.btpGram).add(sums.nvlGram);
      const loss = sums.inGram.sub(returned);
      return {
        stage,
        ...sums,
        returnedGram: returned,
        lossGram: loss,
        lossPercent: percentOf(loss, sums.inGram),
        limitPercent: limits.get(stage) ?? null,
      };
    });
    const returned = worker.sums.productGram
      .add(worker.sums.btpGram)
      .add(worker.sums.nvlGram)
      .add(worker.scrapGram);
    const loss = worker.sums.inGram.sub(returned);
    let limitPercent: Prisma.Decimal | null = null;
    if (
      stages.length > 0 &&
      stages.every((stage) => stage.limitPercent != null) &&
      worker.sums.inGram.gt(0)
    ) {
      limitPercent = stages
        .reduce(
          (sum, stage) => sum.add(stage.inGram.mul(stage.limitPercent!)),
          zero(),
        )
        .div(worker.sums.inGram)
        .toDecimalPlaces(2);
    }
    return {
      week: worker.week,
      workerKey: worker.workerKey,
      workerUserId: worker.workerUserId,
      workerName: worker.workerName,
      ...worker.sums,
      scrapGram: worker.scrapGram,
      returnedGram: returned,
      lossGram: loss,
      lossPercent: percentOf(loss, worker.sums.inGram),
      limitPercent,
      stages,
    };
  });
  rows.sort(
    (a, b) =>
      a.week.localeCompare(b.week) ||
      a.workerName.localeCompare(b.workerName, 'vi'),
  );
  return rows;
}
