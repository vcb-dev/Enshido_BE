import {
  CastingSlipStatus,
  Prisma,
  ProductionStage,
  ProductionStatus,
} from '@prisma/client';
import {
  skipsStone,
  STAGE_LABEL,
  STAGE_ORDER,
  subTicketCode,
  subTicketState,
  ticketStatus,
} from './order-detail';

const S = ProductionStatus;

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Ngày theo giờ Việt Nam (UTC+7) dạng YYYY-MM-DD. */
export function vnDayKey(date: Date) {
  return new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Mốc 00:00 giờ Việt Nam của ngày `key`, cộng thêm `days` ngày. */
export function vnDayStart(key: string, days = 0) {
  return new Date(
    Date.parse(`${key}T00:00:00Z`) - VN_OFFSET_MS + days * DAY_MS,
  );
}

/** Cột `@db.Date` (dueDate) lưu 00:00 UTC — đọc thẳng phần ngày, không cộng giờ. */
export function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** Công đoạn trên màn Tổng quan, theo đúng luồng: tạo đơn → đúc → cắt cây → 5 khâu thợ → nhập kho. */
export const OVERVIEW_STAGES = [
  { key: 'MODEL', label: '3D / Sáp' },
  { key: 'CASTING', label: 'Đúc' },
  { key: 'CUT', label: 'Cắt cây' },
  { key: 'FILING', label: 'Nguội' },
  { key: 'STONE_SETTING', label: 'Vào đá' },
  { key: 'ENGRAVING', label: 'Khắc' },
  { key: 'POLISHING', label: 'Đánh bóng' },
  { key: 'PLATING', label: 'Xi' },
  { key: 'STOCK', label: 'Chờ nhập kho' },
] as const;

export type OverviewStageKey = (typeof OVERVIEW_STAGES)[number]['key'];

/** Khâu thợ (Nguội → Xi) — mỗi vị trí ở đây là một phiếu công đoạn đang mở. */
export const WORKER_STAGE_KEYS: OverviewStageKey[] = [...STAGE_ORDER];

type Slot = { stage: OverviewStageKey; working: boolean };

/**
 * Trạng thái → công đoạn + chờ / đang làm. Trạng thái không có ở đây (chờ duyệt, từ chối, lỗi,
 * sản xuất xong, đã giao) không tính là đang trong xưởng.
 */
const STATUS_SLOT: Partial<Record<ProductionStatus, Slot>> = {
  [S.APPROVED]: { stage: 'MODEL', working: false },
  [S.NEW]: { stage: 'MODEL', working: false },
  [S.READY_FOR_PRODUCTION]: { stage: 'MODEL', working: false },
  [S.REDO_3D]: { stage: 'MODEL', working: true },
  [S.WAX_PRINTED]: { stage: 'MODEL', working: true },
  [S.PENDING_WAREHOUSE_CONFIRMATION]: { stage: 'MODEL', working: true },
  [S.WAX_CONFIRMED]: { stage: 'CASTING', working: false },
  [S.WAIT_CASTING]: { stage: 'CASTING', working: false },
  [S.CASTING]: { stage: 'CASTING', working: true },
  [S.CAST_PENDING_CONFIRMATION]: { stage: 'CASTING', working: true },
  [S.CAST_DONE]: { stage: 'CUT', working: false },
  [S.WAIT_FILING]: { stage: 'FILING', working: false },
  [S.FILING]: { stage: 'FILING', working: true },
  [S.WAIT_STONE]: { stage: 'STONE_SETTING', working: false },
  [S.STONE_SETTING]: { stage: 'STONE_SETTING', working: true },
  [S.WAIT_ENGRAVING]: { stage: 'ENGRAVING', working: false },
  [S.ENGRAVING]: { stage: 'ENGRAVING', working: true },
  [S.WAIT_POLISHING]: { stage: 'POLISHING', working: false },
  [S.POLISHING]: { stage: 'POLISHING', working: true },
  [S.WAIT_PLATING]: { stage: 'PLATING', working: false },
  [S.PLATING]: { stage: 'PLATING', working: true },
  [S.PLATED]: { stage: 'STOCK', working: false },
};

/** Trạng thái đơn có thể còn hàng trong xưởng — lọc trước khi nạp đơn. */
export const OVERVIEW_STATUSES = Object.keys(STATUS_SLOT) as ProductionStatus[];

export const overviewOrderSelect = {
  id: true,
  code: true,
  intakeCode: true,
  productName: true,
  btpName: true,
  description: true,
  qty: true,
  status: true,
  dueDate: true,
  claimedByUserId: true,
  claimedByName: true,
  pendingStage: true,
  stoneCount: true,
  stoneWeight: true,
  stoneSkipped: true,
  receipt: { select: { qty: true, stockedQty: true } },
  subTickets: {
    orderBy: { no: 'asc' as const },
    select: {
      id: true,
      no: true,
      qty: true,
      pendingStage: true,
      claimedByUserId: true,
      claimedByName: true,
      outcome: true,
    },
  },
  stages: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      subTicketId: true,
      stage: true,
      returnedAt: true,
      confirmedAt: true,
      submittedAt: true,
      defectReportedAt: true,
      returnedQty: true,
      craftsmanName: true,
    },
  },
} satisfies Prisma.ProductionOrderSelect;

export type OverviewOrder = Prisma.ProductionOrderGetPayload<{
  select: typeof overviewOrderSelect;
}>;

/** Một chỗ hàng đang nằm trong xưởng: cả đơn (chưa chia) hoặc một phiếu con. */
export type OverviewPosition = {
  orderId: string;
  subTicketNo: number | null;
  code: string;
  orderCode: string | null;
  productName: string;
  stage: OverviewStageKey;
  working: boolean;
  qty: number;
  assignee: string | null;
  dueDate: string | null;
};

/**
 * Các chỗ hàng của một đơn. Đơn đã chia phiếu con đang ở các khâu thì mỗi phiếu con chưa chốt là
 * một chỗ (trạng thái phiếu tính như danh sách đơn); còn lại cả đơn là một chỗ. Đơn Đã xi xong chỉ
 * tính phần kho chưa nhận. Mỗi sản phẩm vì vậy chỉ được đếm một lần.
 */
export function orderPositions(order: OverviewOrder): OverviewPosition[] {
  const base = {
    orderId: order.id,
    orderCode: order.intakeCode,
    productName:
      order.productName ?? order.btpName ?? order.description.split('\n')[0],
    dueDate: order.dueDate ? dateKey(order.dueDate) : null,
  };
  const slot = STATUS_SLOT[order.status];
  if (!slot) return [];

  if (order.subTickets.length > 0 && slot.stage !== 'STOCK') {
    const parentEntries = order.stages.filter((entry) => !entry.subTicketId);
    const orderLast = parentEntries[parentEntries.length - 1]?.stage ?? null;
    const skipStone = skipsStone(order);
    return order.subTickets.flatMap((ticket) => {
      const entries = order.stages.filter(
        (entry) => entry.subTicketId === ticket.id,
      );
      const status = ticketStatus(ticket, entries, orderLast, skipStone);
      const ticketSlot = status ? STATUS_SLOT[status] : undefined;
      if (!ticketSlot) return [];
      const { state } = subTicketState(ticket, entries);
      const open = entries.find((entry) => !entry.returnedAt);
      return [
        {
          ...base,
          subTicketNo: ticket.no,
          code: subTicketCode(order.code, ticket.no, order.subTickets.length),
          ...ticketSlot,
          qty: ticket.qty,
          assignee:
            state === 'CLAIMED'
              ? ticket.claimedByName
              : (open?.craftsmanName ?? null),
        },
      ];
    });
  }

  const qty =
    slot.stage === 'STOCK' && order.receipt
      ? order.receipt.qty - order.receipt.stockedQty
      : order.qty;
  if (qty <= 0) return [];
  const open = order.stages.find(
    (entry) => !entry.subTicketId && !entry.returnedAt,
  );
  return [
    {
      ...base,
      subTicketNo: null,
      code: order.code,
      ...slot,
      qty,
      assignee: open?.craftsmanName ?? order.claimedByName ?? null,
    },
  ];
}

/** Quá hạn = hạn giao của đơn đã qua (trước hôm nay) mà hàng vẫn còn trong xưởng. */
export function isOverdue(position: OverviewPosition, todayKey: string) {
  return position.dueDate != null && position.dueDate < todayKey;
}

/** Bảng phiếu cần theo dõi: quá hạn trước, rồi hạn gần nhất, phiếu không có hạn xếp cuối. */
export function compareWatch(a: OverviewPosition, b: OverviewPosition) {
  if (a.dueDate === b.dueDate) return a.code.localeCompare(b.code);
  if (a.dueDate == null) return 1;
  if (b.dueDate == null) return -1;
  return a.dueDate < b.dueDate ? -1 : 1;
}

/**
 * QC đạt lần đầu: lần làm đầu tiên của khâu, không bị báo lỗi giữa khâu và QC không ghi SL lỗi.
 * Hệ thống chưa có cờ riêng nên suy ra từ các trường này.
 */
export function isFirstPass(entry: {
  attempt: number;
  defectQty: number | null;
  defectReportedAt: Date | null;
}) {
  return (
    entry.attempt === 1 && !entry.defectQty && entry.defectReportedAt == null
  );
}

/**
 * Trạng thái việc của thợ ở một khâu:
 * PENDING chưa làm — đã nhận / được giao, chưa bắt đầu ·
 * WORKING đang làm — đã bắt đầu, chưa được nhận lại ·
 * DONE hoàn thiện — được nhận lại phần đạt · DEFECT lỗi.
 */
export const PERFORMANCE_STATUSES = [
  'PENDING',
  'WORKING',
  'DONE',
  'DEFECT',
] as const;
export type PerformanceStatus = (typeof PERFORMANCE_STATUSES)[number];

/**
 * Khâu trên bảng hiệu suất: 3D, Sáp, Đúc rồi 5 khâu thợ. 3D / Sáp không có bước giao việc hay trả
 * lỗi nên chỉ có Hoàn thiện (lấy từ nhật ký thao tác).
 */
export const PERFORMANCE_STAGES = [
  { key: 'MODEL3D', label: '3D', statuses: ['DONE'] },
  { key: 'WAX', label: 'Sáp', statuses: ['DONE'] },
  { key: 'CASTING', label: 'Đúc', statuses: [...PERFORMANCE_STATUSES] },
  ...STAGE_ORDER.map((stage) => ({
    key: stage,
    label: STAGE_LABEL[stage],
    statuses: [...PERFORMANCE_STATUSES],
  })),
] as const satisfies readonly {
  key: string;
  label: string;
  statuses: readonly PerformanceStatus[];
}[];
export type PerformanceStageKey = (typeof PERFORMANCE_STAGES)[number]['key'];

/** Một phần việc của thợ: một phiếu / đơn ở một khâu, một trạng thái. */
export type PerformanceItem = {
  orderId: string;
  stage: PerformanceStageKey;
  workerId: string | null;
  workerName: string;
  status: PerformanceStatus;
  qty: number;
};

/** Lượt khâu QC đã nhận lại → phần hoàn thiện (SL đạt) và phần lỗi (SL lỗi). */
export function returnedItems(entry: {
  orderId: string;
  stage: ProductionStage;
  craftsmanUserId: string | null;
  craftsmanName: string;
  returnedQty: number | null;
  defectQty: number | null;
}): PerformanceItem[] {
  const base = {
    orderId: entry.orderId,
    stage: entry.stage,
    workerId: entry.craftsmanUserId,
    workerName: entry.craftsmanName,
  };
  const items: PerformanceItem[] = [];
  if (entry.returnedQty) {
    items.push({ ...base, status: 'DONE', qty: entry.returnedQty });
  }
  if (entry.defectQty) {
    items.push({ ...base, status: 'DEFECT', qty: entry.defectQty });
  }
  return items;
}

/** Trạng thái phiếu đúc → trạng thái việc của thợ đúc. Phiếu lỗi tính riêng (đơn đã dời đi). */
export const CASTING_SLIP_PERFORMANCE: Partial<
  Record<CastingSlipStatus, PerformanceStatus>
> = {
  PENDING_ISSUE: 'PENDING',
  WAIT_CASTING: 'PENDING',
  CASTING: 'WORKING',
  PENDING_CONFIRMATION: 'WORKING',
  DONE: 'DONE',
};

/** Mã đơn trong lô đúc ("DH001, DH002") → danh sách mã. */
export function batchCodes(value: string) {
  return value
    .split(/[,;\s]+/)
    .map((code) => code.trim())
    .filter(Boolean);
}

export type PerformanceCount = { orders: number; qty: number };
export type PerformanceCell = Record<PerformanceStatus, PerformanceCount>;

function emptyCell(): PerformanceCell {
  return {
    PENDING: { orders: 0, qty: 0 },
    WORKING: { orders: 0, qty: 0 },
    DONE: { orders: 0, qty: 0 },
    DEFECT: { orders: 0, qty: 0 },
  };
}

/** Tài khoản thợ đang hoạt động — luôn có một dòng dù chưa có việc. */
export type PerformanceWorker = {
  id: string;
  fullName: string;
  /** Khâu tài khoản được làm (3D / Sáp / Đúc theo quyền + khâu thợ đã tick). */
  stages: PerformanceStageKey[];
};

/**
 * Bảng thợ × khâu × trạng thái: mọi thợ trong `workers` một dòng, cộng thêm người có việc mà không
 * còn trong danh sách (tài khoản đã khoá, admin làm thay, thợ ghi tên tay). Đơn = số đơn khác nhau
 * (nhiều phiếu con cùng đơn tính một); sản phẩm = cộng SL.
 */
export function workerPerformance(
  items: readonly PerformanceItem[],
  workers: readonly PerformanceWorker[] = [],
) {
  type Row = {
    workerKey: string;
    workerName: string;
    /** Khâu được làm trên tài khoản; trống = không có tài khoản thợ. */
    workerStages: PerformanceStageKey[];
    cells: Partial<Record<PerformanceStageKey, PerformanceCell>>;
    orderIds: Map<string, Set<string>>;
  };
  const stageOrder = PERFORMANCE_STAGES.map((stage) => stage.key);
  const rows = new Map<string, Row>(
    workers.map((worker) => [
      worker.id,
      {
        workerKey: worker.id,
        workerName: worker.fullName,
        workerStages: stageOrder.filter((stage) =>
          worker.stages.includes(stage),
        ),
        cells: {},
        orderIds: new Map(),
      },
    ]),
  );
  const totals = Object.fromEntries(
    stageOrder.map((stage) => [stage, emptyCell()]),
  ) as Record<PerformanceStageKey, PerformanceCell>;
  const totalOrderIds = new Map<string, Set<string>>();
  const addOrder = (
    sets: Map<string, Set<string>>,
    key: string,
    orderId: string,
  ) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Set()));
    set.add(orderId);
    return set.size;
  };

  for (const item of items) {
    const workerKey = item.workerId ?? `name:${item.workerName}`;
    let row = rows.get(workerKey);
    if (!row) {
      row = {
        workerKey,
        workerName: item.workerName,
        workerStages: [],
        cells: {},
        orderIds: new Map(),
      };
      rows.set(workerKey, row);
    }
    const key = `${item.stage}:${item.status}`;
    const cell = (row.cells[item.stage] ??= emptyCell())[item.status];
    cell.orders = addOrder(row.orderIds, key, item.orderId);
    cell.qty += item.qty;
    const total = totals[item.stage][item.status];
    total.orders = addOrder(totalOrderIds, key, item.orderId);
    total.qty += item.qty;
  }

  const result = [...rows.values()].map(
    ({ workerKey, workerName, workerStages, cells }) => ({
      workerKey,
      workerName,
      workerStages,
      cells,
    }),
  );
  result.sort((a, b) => a.workerName.localeCompare(b.workerName, 'vi'));
  return { rows: result, totals };
}
