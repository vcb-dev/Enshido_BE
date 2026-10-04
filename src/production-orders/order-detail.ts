import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MaterialRequestKind,
  MaterialRequestStatus,
  Prisma,
  ProductionStage,
  ProductionStatus,
  SubTicketOutcome,
} from '@prisma/client';
import { ctStr, decStr } from '../util/money';
import {
  issuedOf,
  lossPercentOf,
  silverInOf,
  silverLossOf,
  stoneLossOf,
} from './stage-math';

const S = ProductionStatus;
const G = ProductionStage;

/** Thứ tự khâu giao thợ trên phiếu: Nguội → Vào đá → Khắc → Đánh bóng → Xi. */
export const STAGE_ORDER: ProductionStage[] = [
  G.FILING,
  G.STONE_SETTING,
  G.ENGRAVING,
  G.POLISHING,
  G.PLATING,
];

/** Khâu cuối trên phiếu (Xi) — phải xong khâu này mới chốt Hoàn thiện được. */
export const LAST_STAGE: ProductionStage = STAGE_ORDER[STAGE_ORDER.length - 1];

/** Khâu trên phiếu → trạng thái đơn. Mỗi khâu một trạng thái. */
export const STAGE_STATUS: Record<ProductionStage, ProductionStatus> = {
  FILING: S.FILING,
  STONE_SETTING: S.STONE_SETTING,
  ENGRAVING: S.ENGRAVING,
  POLISHING: S.POLISHING,
  PLATING: S.PLATING,
};

export const STATUS_LABEL: Record<ProductionStatus, string> = {
  NEW: 'Mới',
  REDO_3D: 'Sửa 3D',
  CASTING: 'Đúc',
  WAIT_FILING: 'Chờ nguội',
  FILING: 'Đang nguội',
  FILING_DEFECT: 'Lỗi nguội',
  WAIT_STONE: 'Chờ vào đá',
  STONE_SETTING: 'Đang vào đá',
  STONE_DEFECT: 'Lỗi vào đá',
  WAIT_ENGRAVING: 'Chờ khắc',
  ENGRAVING: 'Khắc',
  POLISHING: 'Bóng',
  PLATING: 'Xi',
  DEFECT: 'Sản xuất lỗi',
  FINISHING: 'Hoàn thiện',
  DELIVERED: 'Đã giao',
};

export const STAGE_LABEL: Record<ProductionStage, string> = {
  FILING: 'Nguội',
  STONE_SETTING: 'Vào đá',
  ENGRAVING: 'Khắc',
  POLISHING: 'Đánh bóng',
  PLATING: 'Xi',
};

/** Trạng thái đơn đang nằm ở một khâu trên phiếu (có thợ đang giữ hàng hoặc vừa nộp lại). */
export const IN_STAGE_STATUSES: ProductionStatus[] = [
  S.WAIT_FILING,
  S.FILING,
  S.WAIT_STONE,
  S.STONE_SETTING,
  S.WAIT_ENGRAVING,
  S.ENGRAVING,
  S.POLISHING,
  S.PLATING,
];

export const detailInclude = {
  intakeOrder: { select: { code: true, sxCode: true } },
  images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
  stages: {
    orderBy: { createdAt: 'asc' },
    include: { images: { orderBy: { sortOrder: 'asc' } } },
  },
  subTickets: {
    orderBy: { no: 'asc' },
    include: {
      // Đá đang giữ chỗ cho khâu chờ thợ nhận (chưa gắn vào lần giao nào).
      stoneHolds: {
        where: { status: 'HELD', stageEntryId: null },
        select: { stoneCount: true, weight: true },
      },
    },
  },
  // Đơn tạo bù cho hàng lỗi của đơn này — để phiếu lỗi hiện "Phiếu bù: DH…".
  reworkIntakes: {
    select: {
      code: true,
      status: true,
      qty: true,
      reworkOfEntryId: true,
      reworkOfSubTicketId: true,
    },
  },
  materialRequests: {
    orderBy: { requestedAt: 'asc' },
    include: materialRequestMaterial(),
  },
  // Đá Vào đá đã gắn vào lần giao (cấp lúc chỉ định + thợ xin thêm) — QC cân gói thừa theo mã.
  stoneHolds: {
    where: { stageEntryId: { not: null } },
    orderBy: { createdAt: 'asc' },
    include: {
      material: {
        select: {
          id: true,
          sku: true,
          name: true,
          unit: { select: { name: true } },
        },
      },
    },
  },
  statusLogs: { orderBy: { changedAt: 'desc' }, take: 80 },
  parent: {
    select: {
      code: true,
      children: { select: { id: true }, orderBy: { seq: 'asc' } },
    },
  },
  children: { select: { code: true, status: true }, orderBy: { seq: 'asc' } },
  receipt: true,
  btpMaterial: { select: { id: true, sku: true, name: true } },
  nvlMaterial: { select: { id: true, sku: true, name: true } },
  bomLines: {
    orderBy: { sortOrder: 'asc' },
    select: {
      materialId: true,
      platingColor: true,
      qty: true,
      stoneWeight: true,
      laserEngraving: true,
      otherRequirements: true,
      material: { select: { sku: true, name: true } },
    },
  },
  shipmentLines: {
    select: {
      qty: true,
      shipment: { select: { code: true, shippedAt: true, customerName: true } },
    },
    orderBy: { shipment: { seq: 'asc' } },
  },
  _count: { select: { outbounds: true } },
} satisfies Prisma.ProductionOrderInclude;

export type OrderDetail = Prisma.ProductionOrderGetPayload<{
  include: typeof detailInclude;
}>;
/** Khâu trên phiếu — ảnh QC chỉ đọc kèm ở chi tiết đơn, các phép tính không cần. */
export type StageEntry = Omit<OrderDetail['stages'][number], 'images'>;
export type SubTicket = OrderDetail['subTickets'][number];

/**
 * Số lượng phiếu con còn tính vào số lượng đơn: phiếu đã chốt Lỗi không tính nữa, phiếu còn chạy
 * trừ phần hàng lỗi QC đã tách (phần đó do phiếu bù làm lại).
 */
export function ticketNetQty(
  order: Pick<OrderDetail, 'stages'>,
  ticket: Pick<SubTicket, 'id' | 'qty' | 'outcome'>,
) {
  if (ticket.outcome === SubTicketOutcome.DEFECT) return 0;
  const defect = order.stages
    .filter((entry) => entry.subTicketId === ticket.id && entry.confirmedAt)
    .reduce((sum, entry) => sum + (entry.defectQty ?? 0), 0);
  return Math.max(0, ticket.qty - defect);
}
export type MaterialRequest = OrderDetail['materialRequests'][number];

/** Mã NVL kèm theo mỗi yêu cầu xuất — đủ để hiện dòng trên phiếu. */
export function materialRequestMaterial() {
  return {
    material: {
      select: {
        id: true,
        sku: true,
        name: true,
        unit: { select: { name: true } },
        warehouse: { select: { code: true, shortName: true } },
      },
    },
    stoneHold: { select: { status: true } },
  } satisfies Prisma.ProductionMaterialRequestInclude;
}

/**
 * Phiếu con đang ở đâu trong khâu hiện tại:
 * IDLE chờ mở khâu · WAITING chờ thợ nhận · CLAIMED thợ đã nhận, chờ người giao xác nhận ·
 * WORKING đã giao, thợ đang làm · SUBMITTED thợ báo xong, chờ QC cân lại ·
 * CONFIRMING QC đã nhận lại, chờ thủ kho xác nhận (Nguội / Vào đá) ·
 * DEFECT / FINISH là hai nhánh kết thúc phiếu.
 */
export type SubTicketState =
  | 'IDLE'
  | 'WAITING'
  | 'CLAIMED'
  | 'WORKING'
  | 'SUBMITTED'
  | 'CONFIRMING'
  | 'DEFECT'
  | 'FINISH';

/**
 * Mã phiếu. Đơn chỉ có một phiếu thì phiếu chính là đơn — mã là mã đơn; từ hai phiếu trở lên mới
 * thêm số thứ tự (A002-1, A002-2…). Mã có số cũ vẫn mở được (detailByTicket nhận cả hai).
 */
export function subTicketCode(
  orderCode: string,
  no: number,
  ticketCount?: number,
) {
  return ticketCount === 1 ? orderCode : `${orderCode}-${no}`;
}

/** Các lần giao khâu của một phiếu con, theo thứ tự giao. */
export function entriesOf(
  order: Pick<OrderDetail, 'stages'>,
  ticketId: string,
) {
  return order.stages.filter((entry) => entry.subTicketId === ticketId);
}

/**
 * Đá phát cho thợ ở khâu Vào đá — hai trường này chỉ có nghĩa ở khâu đó, khâu khác gửi lên
 * là sai luồng. Cộng dồn các lần giao không được vượt quá số đá ghi trên đơn (lần đang sửa
 * không tính vào phần đã phát). Trả về giá trị đã lọc theo khâu để chỗ ghi DB dùng thẳng.
 */
export function handedStoneOf(
  stage: ProductionStage,
  dto: {
    handedStoneCount?: number | null;
    handedStoneWeight?: string | null;
  },
  order: Pick<
    OrderDetail,
    'stoneCount' | 'stoneWeight' | 'bomLines' | 'stages'
  >,
  currentEntryId: string | null = null,
) {
  if (stage !== G.STONE_SETTING) {
    if (dto.handedStoneCount != null || dto.handedStoneWeight != null) {
      throw new BadRequestException(
        `Chỉ khâu ${STAGE_LABEL[G.STONE_SETTING]} mới ghi đá giao cho thợ`,
      );
    }
    return { handedStoneCount: null, handedStoneWeight: null };
  }
  const handedStoneCount = dto.handedStoneCount ?? null;
  const handedStoneWeight = decimalOrNull(dto.handedStoneWeight);
  const stone = orderStoneOf(order);
  const others = order.stages.filter(
    (entry) => entry.stage === G.STONE_SETTING && entry.id !== currentEntryId,
  );
  if (stone.count != null && handedStoneCount != null) {
    const used = others.reduce(
      (sum, entry) => sum + (entry.handedStoneCount ?? 0),
      0,
    );
    const left = stone.count - used;
    if (handedStoneCount > left) {
      throw new BadRequestException(
        `Đơn chỉ còn ${left < 0 ? 0 : left} viên đá chưa giao`,
      );
    }
  }
  if (stone.weight != null && handedStoneWeight != null) {
    const used = others.reduce(
      (sum, entry) => sum.add(entry.handedStoneWeight ?? 0),
      new Prisma.Decimal(0),
    );
    const left = stone.weight.sub(used);
    if (handedStoneWeight.gt(left)) {
      throw new BadRequestException(
        `Đơn chỉ còn ${ctStr(left.lt(0) ? new Prisma.Decimal(0) : left)} đá chưa giao`,
      );
    }
  }
  return { handedStoneCount, handedStoneWeight };
}

/**
 * Tổng đá ghi lúc lên đơn — cũng là số đã tự xuất khỏi kho NVL chính. Đơn nhiều mã NVL cộng
 * từng dòng; đơn một mã dùng số trên đơn. Chưa dòng nào ghi TL đá thì TL là null (không chặn).
 */
export function orderStoneOf(
  order: Pick<OrderDetail, 'stoneCount' | 'stoneWeight' | 'bomLines'>,
): { count: number | null; weight: Prisma.Decimal | null } {
  if (!order.bomLines.length) {
    return { count: order.stoneCount, weight: order.stoneWeight };
  }
  const weighed = order.bomLines.filter((line) => line.stoneWeight != null);
  return {
    count: order.bomLines.reduce((sum, line) => sum + (line.qty ?? 0), 0),
    weight: weighed.length
      ? weighed.reduce(
          (sum, line) => sum.add(line.stoneWeight!),
          new Prisma.Decimal(0),
        )
      : null,
  };
}

/**
 * Phiếu đã đi hết đến khâu cuối chưa: khâu gần nhất phải là Xi và đã được QC nhận lại. Chưa
 * tới thì không chốt Hoàn thiện được — khâu giữa bỏ qua được, nhưng sửa lại khâu nào sau khi
 * đã xi thì phải xi lại mới chốt.
 */
export function lastStageDone(
  entries: readonly Pick<StageEntry, 'stage' | 'returnedAt'>[],
) {
  const last = entries[entries.length - 1];
  return last?.stage === LAST_STAGE && last.returnedAt != null;
}

/** Các trường của một lần giao khâu mà việc tính trạng thái phiếu con cần tới. */
type StateEntry = Pick<StageEntry, 'stage' | 'returnedAt' | 'submittedAt'> & {
  /** null = QC đã nhận lại nhưng thủ kho chưa xác nhận; bỏ trống = không có bước này. */
  confirmedAt?: Date | null;
  /** Đã báo lỗi ở khâu đang làm — khâu coi như đã nộp cho QC cân lại. */
  defectReportedAt?: Date | null;
};

/** Khâu của phiếu con phải qua thủ kho xác nhận sau QC (mô tả luồng bước 13–18). */
export const KEEPER_CONFIRM_STAGES: ProductionStage[] = [
  G.FILING,
  G.STONE_SETTING,
];

export function subTicketState(
  ticket: Pick<SubTicket, 'pendingStage' | 'claimedByUserId' | 'outcome'>,
  entries: readonly StateEntry[],
): { state: SubTicketState; activeStage: ProductionStage | null } {
  // Phiếu đã chốt lỗi / hoàn thiện thì không còn khâu nào chạy.
  if (ticket.outcome) return { state: ticket.outcome, activeStage: null };
  const open = entries.find((entry) => !entry.returnedAt);
  if (open) {
    return {
      state:
        open.submittedAt || open.defectReportedAt ? 'SUBMITTED' : 'WORKING',
      activeStage: open.stage,
    };
  }
  const unconfirmed = entries.find(
    (entry) => entry.returnedAt && entry.confirmedAt === null,
  );
  if (unconfirmed) {
    return { state: 'CONFIRMING', activeStage: unconfirmed.stage };
  }
  if (ticket.pendingStage) {
    return {
      state: ticket.claimedByUserId ? 'CLAIMED' : 'WAITING',
      activeStage: ticket.pendingStage,
    };
  }
  return { state: 'IDLE', activeStage: null };
}

/**
 * Phiếu con đang đứng ở khâu nào: khâu đang chạy (chờ thợ nhận, đã nhận, đang làm), hoặc
 * khâu vừa xong nếu đang rảnh — hàng vẫn còn phải qua các khâu sau. Phiếu chưa làm khâu
 * nào thì tính theo khâu cuối của cả đơn trước lúc chia. Phiếu đã chốt Lỗi / Hoàn thiện
 * thì không còn đứng ở khâu nào.
 */
export function ticketPosition(
  ticket: Pick<SubTicket, 'pendingStage' | 'claimedByUserId' | 'outcome'>,
  entries: readonly StateEntry[],
  orderLast: ProductionStage | null = null,
): ProductionStage | null {
  if (ticket.outcome) return null;
  const { activeStage } = subTicketState(ticket, entries);
  return activeStage ?? entries[entries.length - 1]?.stage ?? orderLast;
}

/**
 * Các tab mà một đơn phải xuất hiện trên danh sách. Một đơn đã chia có thể đồng thời nằm ở
 * nhiều khâu vì từng phiếu con chạy độc lập; phiếu đã chốt thì nằm ở Lỗi / Hoàn thiện.
 */
export function orderListStatuses(order: {
  status: ProductionStatus;
  stoneCount?: number | null;
  subTickets: readonly Pick<
    SubTicket,
    'id' | 'pendingStage' | 'claimedByUserId' | 'outcome'
  >[];
  stages: readonly (StateEntry & Pick<StageEntry, 'subTicketId'>)[];
}): ProductionStatus[] {
  const statuses = new Set<ProductionStatus>();
  // Đơn chưa chia lấy trạng thái của chính nó. Với đơn đã chia, trạng thái khâu của đơn mẹ
  // chỉ là giá trị tổng hợp; từng phiếu bên dưới mới là nguồn đúng để xếp tab khâu.
  if (
    order.subTickets.length === 0 ||
    !IN_STAGE_STATUSES.includes(order.status)
  ) {
    statuses.add(order.status);
  }
  const parentEntries = order.stages.filter((entry) => !entry.subTicketId);
  const orderLast = parentEntries[parentEntries.length - 1]?.stage ?? null;
  for (const ticket of order.subTickets) {
    if (ticket.outcome === SubTicketOutcome.DEFECT) {
      statuses.add(outcomeStatus(ticket));
      continue;
    }
    if (ticket.outcome === SubTicketOutcome.FINISH) {
      statuses.add(S.FINISHING);
      continue;
    }
    const entries = order.stages.filter(
      (entry) => entry.subTicketId === ticket.id,
    );
    const status = ticketStatus(
      ticket,
      entries,
      orderLast,
      order.stoneCount === 0,
    );
    if (status) statuses.add(status);
  }
  if (statuses.size === 0) statuses.add(order.status);
  return [...statuses];
}

/**
 * Tóm tắt một phiếu con cho danh sách đơn: đang ở khâu nào, trạng thái gì, ai đang giữ hàng.
 * Khâu lấy giống cột Khâu ở bảng phiếu con trong trang đơn — khâu đang chạy, hoặc khâu vừa
 * xong nếu đang rảnh / đã chốt. Thợ chỉ ghi người đang giữ (đã nhận hoặc đang làm); đang chờ
 * nhận thì chưa có ai. `entries` phải theo thứ tự giao.
 */
export function subTicketSummary(
  orderCode: string,
  ticket: Pick<
    SubTicket,
    | 'no'
    | 'qty'
    | 'note'
    | 'createdAt'
    | 'pendingStage'
    | 'claimedByUserId'
    | 'claimedByName'
    | 'outcome'
  >,
  entries: readonly (StateEntry & Pick<StageEntry, 'craftsmanName'>)[],
  orderLast: ProductionStage | null = null,
  skipStone = false,
  ticketCount?: number,
) {
  const { state, activeStage } = subTicketState(ticket, entries);
  const open = entries.find((entry) => !entry.returnedAt);
  return {
    code: subTicketCode(orderCode, ticket.no, ticketCount),
    no: ticket.no,
    qty: ticket.qty,
    note: ticket.note,
    createdAt: ticket.createdAt.toISOString(),
    state,
    /** Trạng thái thật của phiếu (I/K/L/N/O…) — dùng xếp tab và hiện chip. */
    status:
      ticketStatus(ticket, entries, orderLast, skipStone) ??
      outcomeStatus(ticket),
    stage: activeStage ?? entries[entries.length - 1]?.stage ?? null,
    workerName:
      state === 'CLAIMED'
        ? ticket.claimedByName
        : state === 'WORKING' || state === 'SUBMITTED'
          ? (open?.craftsmanName ?? null)
          : null,
  };
}

/**
 * Thứ tự "tích cực" của trạng thái đơn — phiếu con đi lệch nhau thì đơn lấy trạng thái của phiếu
 * đi xa nhất (mô tả luồng, ghi chú bước 15). Lỗi xếp thấp nhất: còn phiếu khác chạy thì đơn
 * không báo lỗi.
 */
export const STATUS_RANK: ProductionStatus[] = [
  S.FILING_DEFECT,
  S.STONE_DEFECT,
  S.WAIT_FILING,
  S.FILING,
  S.WAIT_STONE,
  S.STONE_SETTING,
  S.WAIT_ENGRAVING,
  S.ENGRAVING,
  S.POLISHING,
  S.PLATING,
];

export function furthestStatus(
  statuses: readonly (ProductionStatus | null)[],
): ProductionStatus | null {
  let best: ProductionStatus | null = null;
  for (const status of statuses) {
    const rank = status ? STATUS_RANK.indexOf(status) : -1;
    if (rank >= 0 && (best === null || rank > STATUS_RANK.indexOf(best))) {
      best = status;
    }
  }
  return best;
}

/** Khâu đang chờ thợ nhận → trạng thái "Chờ …" (khâu không có trạng thái chờ riêng giữ trạng thái khâu). */
const WAITING_STATUS: Record<ProductionStage, ProductionStatus> = {
  FILING: S.WAIT_FILING,
  STONE_SETTING: S.WAIT_STONE,
  ENGRAVING: S.WAIT_ENGRAVING,
  POLISHING: S.POLISHING,
  PLATING: S.PLATING,
};

/**
 * Trạng thái của phiếu đã chốt kết cục: Hoàn thiện, hoặc Lỗi — lỗi ở Nguội / Vào đá có trạng
 * thái riêng (M Lỗi nguội, Lỗi vào đá), các khâu khác là "Sản xuất lỗi" chung. Trạng thái của
 * cả đơn khi mọi phiếu lỗi vẫn là Sản xuất lỗi.
 */
export function outcomeStatus(
  ticket: Pick<SubTicket, 'outcome'> & {
    outcomeStage?: ProductionStage | null;
  },
): ProductionStatus {
  if (ticket.outcome === SubTicketOutcome.FINISH) return S.FINISHING;
  if (ticket.outcomeStage === G.FILING) return S.FILING_DEFECT;
  if (ticket.outcomeStage === G.STONE_SETTING) return S.STONE_DEFECT;
  return S.DEFECT;
}

/**
 * Trạng thái của một phiếu con (hoặc cả đơn chưa chia) suy từ khâu đang chạy:
 * - đang làm / đã báo xong → trạng thái khâu (K Đang nguội, N Đang vào đá…);
 * - đã mở khâu, chờ thợ → "Chờ …";
 * - rảnh sau khi QC nhận lại → "Chờ" khâu kế (L sau Nguội, O sau Vào đá);
 * - chưa làm khâu nào → I Chờ nguội.
 * `skipStone`: đơn không có đá thì sau Nguội đi thẳng sang Chờ khắc (bỏ Vào đá).
 * Trả null khi phiếu đã chốt Lỗi / Hoàn thiện — kết cục do `syncOrder` xử lý.
 */
export function ticketStatus(
  ticket: Pick<SubTicket, 'pendingStage' | 'claimedByUserId' | 'outcome'>,
  entries: readonly StateEntry[],
  orderLast: ProductionStage | null = null,
  skipStone = false,
): ProductionStatus | null {
  if (ticket.outcome) return null;
  const { state, activeStage } = subTicketState(ticket, entries);
  if (activeStage) {
    return state === 'WAITING' || state === 'CLAIMED'
      ? WAITING_STATUS[activeStage]
      : STAGE_STATUS[activeStage];
  }
  const last = entries[entries.length - 1]?.stage ?? orderLast;
  switch (last) {
    case null:
    case undefined:
      return S.WAIT_FILING;
    case G.FILING:
      return skipStone ? S.WAIT_ENGRAVING : S.WAIT_STONE;
    case G.STONE_SETTING:
      return S.WAIT_ENGRAVING;
    default:
      return STAGE_STATUS[last];
  }
}

/**
 * Trạng thái đơn tính lại từ các phiếu con còn chạy (hoặc từ chính đơn khi chưa chia):
 * phiếu đi xa nhất quyết định. Đơn đang ở ngoài các trạng thái khâu (Đúc, Lỗi, Hoàn thiện…) hoặc
 * mọi phiếu đã có kết cục thì giữ nguyên.
 */
export function deriveOrderStatus(
  order: {
    status: ProductionStatus;
    /** 0 = đơn không có đá (theo 3D) → sau Nguội đi thẳng sang Chờ khắc. */
    stoneCount?: number | null;
    pendingStage: ProductionStage | null;
    claimedByUserId: string | null;
    subTickets: readonly Pick<
      SubTicket,
      'id' | 'pendingStage' | 'claimedByUserId' | 'outcome'
    >[];
    stages: readonly (StateEntry & Pick<StageEntry, 'subTicketId'>)[];
  },
  skipStone = order.stoneCount === 0,
): ProductionStatus {
  if (!IN_STAGE_STATUSES.includes(order.status)) return order.status;
  const parentEntries = order.stages.filter((entry) => !entry.subTicketId);
  const orderLast = parentEntries[parentEntries.length - 1]?.stage ?? null;
  if (order.subTickets.length === 0) {
    return (
      ticketStatus(
        {
          pendingStage: order.pendingStage,
          claimedByUserId: order.claimedByUserId,
          outcome: null,
        },
        parentEntries,
        null,
        skipStone,
      ) ?? order.status
    );
  }
  return (
    furthestStatus(
      order.subTickets.map((ticket) =>
        ticketStatus(
          ticket,
          order.stages.filter((entry) => entry.subTicketId === ticket.id),
          orderLast,
          skipStone,
        ),
      ),
    ) ?? order.status
  );
}

/**
 * Số lượng / bạc phiếu con đang có trong tay để giao khâu kế tiếp.
 *
 * - Chưa làm khâu nào: phần đã chia; bạc chưa có — người giao cân lúc giao khâu đầu.
 * - Đang làm dở: số đã giao.
 * - Khâu trước xong rồi: số QC trả lại.
 */
export function subTicketAvailable(
  ticket: Pick<SubTicket, 'qty'>,
  entries: readonly Pick<
    StageEntry,
    | 'returnedAt'
    | 'handedQty'
    | 'handedSilverWeight'
    | 'returnedQty'
    | 'returnedSilverWeight'
  >[],
): { qty: number; silver: Prisma.Decimal | null } {
  const last = entries[entries.length - 1];
  if (!last) return { qty: ticket.qty, silver: null };
  if (!last.returnedAt) {
    return {
      qty: last.handedQty ?? ticket.qty,
      silver: last.handedSilverWeight,
    };
  }
  return {
    qty: last.returnedQty ?? last.handedQty ?? ticket.qty,
    silver: last.returnedSilverWeight,
  };
}

/**
 * Danh sách "vừa nộp" của thợ, gộp từ phiếu mẹ và phiếu con. Phải trộn theo thời gian rồi
 * mới cắt: nối đuôi nhau thì một nguồn luôn chiếm chỗ và đẩy phiếu mới hơn của nguồn kia
 * ra ngoài. Mốc là chuỗi ISO nên so trực tiếp được.
 */
export function recentFirst<T extends { returnedAt: string | null }>(
  items: readonly T[],
  limit: number,
) {
  return [...items]
    .sort((a, b) => (b.returnedAt ?? '').localeCompare(a.returnedAt ?? ''))
    .slice(0, limit);
}

/** Các lần giao khâu trực tiếp trên phiếu mẹ. */
export function orderEntries(order: Pick<OrderDetail, 'stages'>) {
  return order.stages.filter((entry) => !entry.subTicketId);
}

/** Phiếu mẹ dùng cùng state machine chờ nhận → đã nhận → đang làm → chờ QC như phiếu con. */
export function orderTicketState(
  order: Pick<OrderDetail, 'pendingStage' | 'claimedByUserId'> & {
    /** Chỉ cần biết đơn đã có phiếu nhập kho hay chưa, nên chỗ gọi được select gọn. */
    receipt: { id: string } | null;
  },
  entries: readonly StateEntry[],
) {
  return subTicketState(
    {
      pendingStage: order.pendingStage,
      claimedByUserId: order.claimedByUserId,
      outcome: order.receipt ? SubTicketOutcome.FINISH : null,
    },
    entries,
  );
}

/** Số lượng / bạc còn lại để giao khâu kế tiếp trên phiếu mẹ. */
export function orderTicketAvailable(
  order: Pick<OrderDetail, 'qty'>,
  entries: readonly Pick<
    StageEntry,
    'handedQty' | 'handedSilverWeight' | 'returnedQty' | 'returnedSilverWeight'
  >[],
) {
  const last = entries[entries.length - 1];
  return {
    qty: last?.returnedQty ?? last?.handedQty ?? order.qty,
    silver: last?.returnedSilverWeight ?? last?.handedSilverWeight ?? null,
  };
}

/**
 * TL hàng tối đa được giao vào một khâu (khâu kế tiếp, hoặc khâu `editingEntryId` đang sửa):
 * không vượt số hàng đang có trong tay QC.
 * - Có khâu trước trên cùng phiếu: = TL QC nhận lại khâu đó.
 * - Khâu đầu của phiếu: lấy từ nguồn chung — TL phiếu mẹ nhận lại lần cuối (đã chia phiếu sau
 *   khi làm trên phiếu mẹ), không thì TL phôi sau đúc — trừ phần các phiếu con khác đã nhận.
 * `null` = không có mốc (đơn cũ chưa có số liệu) → không chặn.
 */
export function handoverSilverLimit(
  order: Pick<OrderDetail, 'stages' | 'blankWeight'>,
  ticketId: string | null,
  editingEntryId?: string,
): Prisma.Decimal | null {
  const scope = order.stages.filter(
    (entry) => (entry.subTicketId ?? null) === ticketId,
  );
  const at = editingEntryId
    ? scope.findIndex((entry) => entry.id === editingEntryId)
    : -1;
  const before = at >= 0 ? scope.slice(0, at) : scope;
  const prev = before[before.length - 1];
  if (prev) return prev.returnedSilverWeight;

  const blank = order.blankWeight;
  const parentEntries = order.stages.filter((entry) => !entry.subTicketId);
  const lastParent = ticketId
    ? parentEntries[parentEntries.length - 1]
    : undefined;
  const pool = lastParent ? lastParent.returnedSilverWeight : blank;
  if (pool == null) return null;
  if (!ticketId) return pool;

  // Khâu đầu của từng phiếu con khác đã lấy từ cùng nguồn.
  const firstOf = new Map<string, Prisma.Decimal | null>();
  for (const entry of order.stages) {
    if (entry.subTicketId && !firstOf.has(entry.subTicketId)) {
      firstOf.set(entry.subTicketId, entry.handedSilverWeight);
    }
  }
  let used = new Prisma.Decimal(0);
  for (const [id, handed] of firstOf) {
    if (id !== ticketId && handed) used = used.add(handed);
  }
  const left = pool.sub(used);
  return left.isNegative() ? new Prisma.Decimal(0) : left;
}

/** Chỉ cần phôi sau đúc và các yêu cầu đã xuất — trang danh sách select gọn được. */
type BlankSource = {
  blankQty: number | null;
  blankWeight: Prisma.Decimal | null;
  blankMaterialId: string | null;
  materialRequests: readonly {
    status: MaterialRequestStatus;
    materialId: string;
    issuedQty: Prisma.Decimal | null;
    issuedWeight: Prisma.Decimal | null;
  }[];
};

/**
 * Phôi của đơn còn trên kho BTP: phôi sau đúc trừ phần đã xuất cho thợ (mọi phiếu, mọi khâu).
 * Mã phôi gom theo mã sản phẩm nên dùng chung giữa các đơn — không có mốc này thì một đơn
 * xuất lấn sang phôi của đơn khác.
 */
export function blankLeftOf(order: BlankSource) {
  const blank =
    order.blankMaterialId && order.blankQty != null && order.blankWeight != null
      ? {
          btpMaterialId: order.blankMaterialId,
          qty: order.blankQty,
          weight: order.blankWeight,
        }
      : null;
  if (!blank?.btpMaterialId)
    return { btpMaterialId: null, leftQty: null, leftWeight: null };
  let qty = new Prisma.Decimal(0);
  let weight = new Prisma.Decimal(0);
  for (const request of order.materialRequests) {
    if (
      request.status === MaterialRequestStatus.ISSUED &&
      request.materialId === blank.btpMaterialId
    ) {
      qty = qty.add(request.issuedQty ?? 0);
      weight = weight.add(request.issuedWeight ?? 0);
    }
  }
  return {
    btpMaterialId: blank.btpMaterialId,
    leftQty: decStr(new Prisma.Decimal(blank.qty).sub(qty)),
    leftWeight: decStr(blank.weight.sub(weight)),
  };
}

/** Mốc xuất cho một mã: chỉ có khi mã đó là phôi sau đúc của đơn. */
export function blankLimitFor(order: BlankSource, materialId: string) {
  const left = blankLeftOf(order);
  if (left.btpMaterialId !== materialId) return null;
  return { qty: left.leftQty, weight: left.leftWeight };
}

/** Chặn TL giao vượt hàng đang có — dùng chung cho xác nhận giao và sửa thông tin giao. */
export function assertHandedSilverWithin(
  order: Pick<OrderDetail, 'stages' | 'blankWeight'>,
  ticketId: string | null,
  handed: Prisma.Decimal | null,
  editingEntryId?: string,
) {
  if (handed == null) return;
  const limit = handoverSilverLimit(order, ticketId, editingEntryId);
  if (limit != null && handed.gt(limit)) {
    throw new BadRequestException(
      `TL giao (${decStr(handed)} g) vượt số hàng đang có (${decStr(limit)} g)`,
    );
  }
}

/** Khâu cấp đơn (không thuộc phiếu con) đang chờ QC nhận lại. */
export function openOrderEntry(order: Pick<OrderDetail, 'stages'>) {
  return order.stages.find((entry) => !entry.subTicketId && !entry.returnedAt);
}

function decOrNull(value: Prisma.Decimal | null) {
  return value != null ? decStr(value) : null;
}

export function toDetail(order: OrderDetail) {
  // Phân đơn: đơn con đánh số theo thứ tự tạo trong các đơn con của cùng đơn mẹ.
  const siblings = order.parent?.children ?? [];
  const splitIndex = siblings.findIndex((child) => child.id === order.id);
  const split =
    splitIndex >= 0
      ? { no: splitIndex + 1, total: siblings.length }
      : { no: 1, total: 1 };
  const ticketNo = new Map(order.subTickets.map((t) => [t.id, t.no]));
  const parentEntries = orderEntries(order);
  const parentState = orderTicketState(order, parentEntries);
  const parentAvailable = orderTicketAvailable(order, parentEntries);
  const parentOpen = parentEntries.find((entry) => !entry.returnedAt);

  return {
    id: order.id,
    code: order.code,
    intakeOrderCode: order.intakeOrder?.code ?? null,
    intakeSxCode: order.intakeOrder?.sxCode ?? null,
    status: order.status,
    source: order.source,
    btp: order.btpMaterial,
    btpSku: order.btpMaterial?.sku ?? null,
    nvl: order.nvlMaterial,
    sourceOrderCode: order.sourceOrderCode,
    requestType: order.requestType,
    qty: order.qty,
    qtyUnit: order.qtyUnit,
    finishedProductQty: order.finishedProductQty,
    returnedQty: order.returnedQty,
    model3dCode: order.model3dCode,
    model3dUrl: order.model3dUrl,
    leadTime: order.leadTime,
    trackingCode: order.trackingCode,
    closedBy: order.closedBy,
    customerName: order.customerName,
    description: order.description,
    stoneColor: order.stoneColor,
    stoneTypes: order.stoneTypes,
    stoneCount: order.stoneCount,
    stoneWeight: order.stoneWeight != null ? decStr(order.stoneWeight) : null,
    weight: order.weight != null ? decStr(order.weight) : null,
    size: order.size,
    sizeLabel: order.sizeLabel,
    mainMaterial: order.mainMaterial,
    platingColor: order.platingColor,
    btpCategory: order.btpCategory,
    btpName: order.btpName,
    productKind: order.productKind,
    laserEngraving: order.laserEngraving,
    otherRequirements: order.otherRequirements,
    nvlLines: order.bomLines.map((line) => ({
      materialId: line.materialId,
      sku: line.material.sku,
      name: line.material.name,
      platingColor: line.platingColor,
      qty: line.qty,
      stoneWeight: line.stoneWeight != null ? decStr(line.stoneWeight) : null,
      laserEngraving: line.laserEngraving,
      otherRequirements: line.otherRequirements,
    })),
    askedUserId: order.askedUserId,
    askedUserName: order.askedUserName,
    receivedDate: ymd(order.receivedDate),
    dueDate: order.dueDate ? ymd(order.dueDate) : null,
    castingSentDate: order.castingSentDate ? ymd(order.castingSentDate) : null,
    castingReturnedDate: order.castingReturnedDate
      ? ymd(order.castingReturnedDate)
      : null,
    cutAt: order.cutAt ? order.cutAt.toISOString() : null,
    // Phôi đơn nhận lúc xác nhận phiếu đúc — mốc bạc giao khâu Nguội.
    cut:
      order.blankWeight != null && order.blankQty != null
        ? {
            code: null,
            cutAt: order.cutAt?.toISOString() ?? null,
            qty: order.blankQty,
            weight: decStr(order.blankWeight),
            ...blankLeftOf(order),
          }
        : null,
    debtStatus: order.debtStatus,
    parentCode: order.parent?.code ?? null,
    split,
    children: order.children,
    linkedOutbounds: order._count.outbounds,
    finishedGoods: order.receipt
      ? {
          qty: order.receipt.stockedQty,
          pendingQty: Math.max(0, order.receipt.qty - order.receipt.stockedQty),
          completedQty: order.receipt.qty,
          receivedAt: order.receipt.receivedAt.toISOString(),
          receivedByName: order.receipt.receivedByName,
          shippedQty: order.shipmentLines.reduce(
            (sum, line) => sum + line.qty,
            0,
          ),
          remainingQty:
            order.receipt.stockedQty -
            order.shipmentLines.reduce((sum, line) => sum + line.qty, 0),
          shipments: order.shipmentLines.map((line) => ({
            code: line.shipment.code,
            shippedAt: ymd(line.shipment.shippedAt),
            customerName: line.shipment.customerName,
            qty: line.qty,
          })),
        }
      : null,
    lastPrintedAt: order.lastPrintedAt?.toISOString() ?? null,
    dataChangedAt: order.dataChangedAt.toISOString(),
    createdBy: order.createdBy,
    createdByUserId: order.createdByUserId,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    images: order.images.map((image) => ({
      id: image.id,
      kind: image.kind,
      url: image.url,
      publicId: image.publicId,
      width: image.width,
      height: image.height,
    })),
    stages: order.stages.map((entry) => {
      return {
        ...toStage(
          entry,
          entry.subTicketId ? (ticketNo.get(entry.subTicketId) ?? null) : null,
          requestsOf(order, entry.id),
          order.stoneHolds,
        ),
        /** Ảnh làm chứng QC chụp lúc nhận lại. */
        images: entry.images.map((image) => ({
          url: image.url,
          publicId: image.publicId,
          width: image.width,
          height: image.height,
        })),
      };
    }),
    materialRequests: order.materialRequests.map((request) => ({
      ...toMaterialRequest(
        request,
        order.code,
        request.subTicketId
          ? (ticketNo.get(request.subTicketId) ?? null)
          : null,
        order.stages.find((entry) => entry.id === request.stageEntryId)
          ?.stage ?? null,
        order.subTickets.length,
      ),
      blankLeft: blankLimitFor(order, request.materialId),
    })),
    workTicket:
      order.subTickets.length === 0
        ? {
            code: order.code,
            state: parentState.state,
            activeStage: parentState.activeStage,
            pendingStage: order.pendingStage,
            pendingAt: order.pendingAt?.toISOString() ?? null,
            pendingByName: order.pendingByName,
            claimedByUserId: order.claimedByUserId,
            claimedByName: order.claimedByName,
            claimedAt: order.claimedAt?.toISOString() ?? null,
            openEntryId: parentOpen?.id ?? null,
            availableQty: parentAvailable.qty,
            availableSilver:
              parentAvailable.silver != null
                ? decStr(parentAvailable.silver)
                : null,
            handoverSilverLimit: decOrNull(handoverSilverLimit(order, null)),
            materials: ticketMaterials(
              parentEntries,
              order.materialRequests,
              order.stoneHolds,
            ),
          }
        : null,
    subTickets: order.subTickets.map((ticket) => toSubTicket(order, ticket)),
    subTicketTotals: {
      qty: order.subTickets.reduce(
        (sum, ticket) => sum + ticketNetQty(order, ticket),
        0,
      ),
    },
    /** Phiếu bù cho hàng lỗi Nguội / Vào đá: đơn tạo bù đang đi lại từ bước sáp. */
    reworks: order.reworkIntakes.map((rework) => ({
      code: rework.code,
      status: rework.status,
      qty: rework.qty,
      entryId: rework.reworkOfEntryId,
      ticketNo:
        order.subTickets.find(
          (ticket) => ticket.id === rework.reworkOfSubTicketId,
        )?.no ?? null,
    })),
    /** NVL xuất thêm + hao hụt của cả đơn, cộng mọi phiếu. */
    materials: ticketMaterials(
      order.stages,
      order.materialRequests,
      order.stoneHolds,
    ),
    statusLogs: order.statusLogs.map((log) => ({
      id: log.id,
      fromStatus: log.fromStatus,
      toStatus: log.toStatus,
      note: log.note,
      changedBy: log.changedBy,
      changedAt: log.changedAt.toISOString(),
    })),
  };
}

function toSubTicket(order: OrderDetail, ticket: SubTicket) {
  const entries = entriesOf(order, ticket.id);
  const { state, activeStage } = subTicketState(ticket, entries);
  const available = subTicketAvailable(ticket, entries);
  const open = entries.find((entry) => !entry.returnedAt);
  return {
    id: ticket.id,
    no: ticket.no,
    code: subTicketCode(order.code, ticket.no, order.subTickets.length),
    qty: ticket.qty,
    note: ticket.note,
    state,
    activeStage,
    /** Trạng thái thật của phiếu (I/K/L/N/O…); đã chốt kết cục thì là Lỗi / Hoàn thiện. */
    status:
      ticketStatus(
        ticket,
        entries,
        orderEntries(order).slice(-1)[0]?.stage ?? null,
        order.stoneCount === 0,
      ) ?? outcomeStatus(ticket),
    /** Đá thủ kho đã cấp (giữ chỗ) cho khâu Vào đá đang chờ thợ nhận. */
    heldStoneCount: (ticket.stoneHolds ?? []).reduce(
      (sum, hold) => sum + (hold.stoneCount ?? 0),
      0,
    ),
    heldStoneWeight: (ticket.stoneHolds ?? []).some(
      (hold) => hold.weight != null,
    )
      ? decStr(
          (ticket.stoneHolds ?? []).reduce(
            (sum, hold) => sum.add(hold.weight ?? 0),
            new Prisma.Decimal(0),
          ),
        )
      : null,
    pendingStage: ticket.pendingStage,
    pendingAt: ticket.pendingAt?.toISOString() ?? null,
    pendingByName: ticket.pendingByName,
    claimedByUserId: ticket.claimedByUserId,
    claimedByName: ticket.claimedByName,
    claimedAt: ticket.claimedAt?.toISOString() ?? null,
    openEntryId: open?.id ?? null,
    entryCount: entries.length,
    materials: ticketMaterials(
      entries,
      order.materialRequests.filter(
        (request) => request.subTicketId === ticket.id,
      ),
      order.stoneHolds,
    ),
    outcome: ticket.outcome,
    outcomeAt: ticket.outcomeAt?.toISOString() ?? null,
    outcomeByName: ticket.outcomeByName,
    outcomeStage: ticket.outcomeStage,
    outcomeQty: ticket.outcomeQty,
    outcomeNote: ticket.outcomeNote,
    availableQty: available.qty,
    availableSilver: available.silver != null ? decStr(available.silver) : null,
    /** Mốc TL giao tối đa cho khâu kế tiếp của phiếu. */
    handoverSilverLimit: decOrNull(handoverSilverLimit(order, ticket.id)),
    lastPrintedAt: ticket.lastPrintedAt?.toISOString() ?? null,
    createdByName: ticket.createdByName,
    createdAt: ticket.createdAt.toISOString(),
  };
}

/** Yêu cầu xuất NVL của một lần giao khâu. */
export function requestsOf(
  order: Pick<OrderDetail, 'materialRequests'>,
  stageEntryId: string,
) {
  return order.materialRequests.filter(
    (request) => request.stageEntryId === stageEntryId,
  );
}

const dec = (value: Prisma.Decimal | null) =>
  value != null ? decStr(value) : null;

export type StoneHold = OrderDetail['stoneHolds'][number];

/**
 * Đá giữ chỗ của một khâu Vào đá, gộp theo mã: SL / viên / TL gói đã cấp, TL gói thừa QC cân,
 * viên thừa quy đổi và viên đã xuất (sau khi thủ kho xác nhận).
 */
function stoneLinesOf(holds: readonly StoneHold[]) {
  const lines = new Map<
    string,
    {
      materialId: string;
      sku: string | null;
      name: string;
      unit: string;
      qty: Prisma.Decimal;
      stoneCount: number | null;
      weight: Prisma.Decimal | null;
      earlyReturnedWeight: Prisma.Decimal | null;
      earlyReturnedCount: number | null;
      returnedWeight: Prisma.Decimal | null;
      returnedCount: number | null;
      usedCount: number | null;
      extra: number;
      done: boolean;
    }
  >();
  const add = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) =>
    a != null && b != null ? a.add(b) : null;
  /** Cộng số có thể rỗng: cả hai rỗng thì rỗng, một bên rỗng coi như 0. */
  const sumDec = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) =>
    a == null && b == null ? null : (a ?? new Prisma.Decimal(0)).add(b ?? 0);
  const sumInt = (a: number | null, b: number | null) =>
    a == null && b == null ? null : (a ?? 0) + (b ?? 0);
  for (const hold of holds) {
    const done = hold.status !== 'HELD';
    const line = lines.get(hold.materialId);
    if (!line) {
      lines.set(hold.materialId, {
        materialId: hold.materialId,
        sku: hold.material.sku,
        name: hold.material.name,
        unit: hold.material.unit.name,
        qty: hold.qty,
        stoneCount: hold.stoneCount,
        weight: hold.weight,
        earlyReturnedWeight: hold.earlyReturnedWeight,
        earlyReturnedCount: hold.earlyReturnedCount,
        returnedWeight: hold.returnedWeight,
        returnedCount: hold.returnedCount,
        usedCount: hold.usedCount,
        extra: hold.requestId ? 1 : 0,
        done,
      });
      continue;
    }
    line.qty = line.qty.add(hold.qty);
    line.stoneCount = sumInt(line.stoneCount, hold.stoneCount);
    line.weight = add(line.weight, hold.weight);
    line.earlyReturnedWeight = sumDec(
      line.earlyReturnedWeight,
      hold.earlyReturnedWeight,
    );
    line.earlyReturnedCount = sumInt(
      line.earlyReturnedCount,
      hold.earlyReturnedCount,
    );
    line.returnedWeight = sumDec(line.returnedWeight, hold.returnedWeight);
    line.returnedCount = sumInt(line.returnedCount, hold.returnedCount);
    line.usedCount =
      line.usedCount == null || hold.usedCount == null
        ? null
        : line.usedCount + hold.usedCount;
    line.extra += hold.requestId ? 1 : 0;
    line.done = line.done && done;
  }
  return [...lines.values()].map((line) => ({
    materialId: line.materialId,
    sku: line.sku,
    name: line.name,
    unit: line.unit,
    /** SL / viên / TL gói còn đang giữ cho thợ (đã trừ túi trả giữa khâu). */
    qty: decStr(line.qty),
    stoneCount: line.stoneCount,
    /** TL gói đang giữ (g); null = có dòng cấp cũ không cân gói. */
    weight: dec(line.weight),
    /** Túi thợ trả giữa khâu (đổi size) — đã nhả khỏi giữ chỗ. */
    earlyReturnedWeight: dec(line.earlyReturnedWeight),
    earlyReturnedCount: line.earlyReturnedCount,
    returnedWeight: dec(line.returnedWeight),
    returnedCount: line.returnedCount,
    /** Viên đã xuất kho — chỉ có khi thủ kho đã xác nhận cả mã. */
    usedCount: line.done ? line.usedCount : null,
    /** Số lần thợ xin thêm mã này trong khâu. */
    extraCount: line.extra,
  }));
}

/** Tổng túi đá thợ trả giữa khâu của một lần giao — trừ khỏi đá đã phát khi tính hao hụt. */
export function earlyReturnedOf(
  holds: readonly {
    stageEntryId: string | null;
    earlyReturnedWeight: Prisma.Decimal | null;
    earlyReturnedCount: number | null;
  }[],
  entryId: string,
) {
  const mine = holds.filter((hold) => hold.stageEntryId === entryId);
  return {
    weight: mine.reduce(
      (sum, hold) => sum.add(hold.earlyReturnedWeight ?? 0),
      new Prisma.Decimal(0),
    ),
    count: mine.reduce((sum, hold) => sum + (hold.earlyReturnedCount ?? 0), 0),
  };
}

export function toStage(
  entry: StageEntry,
  subTicketNo: number | null = null,
  requests: readonly MaterialRequest[] = [],
  holds: readonly StoneHold[] = [],
) {
  const issued = issuedOf(requests);
  const silverIn = silverInOf(entry, issued.metal);
  const silverLoss = silverLossOf(entry, issued.metal);
  // Túi thợ trả giữa khâu (đổi size) không còn tính là đá đã phát cho thợ.
  const early = earlyReturnedOf(holds, entry.id);
  const stone = stoneLossOf(entry, issued.stones - early.count);

  return {
    id: entry.id,
    subTicketId: entry.subTicketId,
    subTicketNo,
    stage: entry.stage,
    attempt: entry.attempt,
    handedByName: entry.handedByName,
    handedAt: entry.handedAt.toISOString(),
    handedQty: entry.handedQty,
    handedSilverWeight: dec(entry.handedSilverWeight),
    handedStoneCount: entry.handedStoneCount,
    handedStoneWeight: dec(entry.handedStoneWeight),
    /** Bạc / đá xuất thêm trong khâu theo yêu cầu của thợ (đã xuất). */
    issuedMetalWeight: dec(issued.metal),
    issuedStoneCount: issued.stones,
    issuedStoneWeight: dec(issued.stoneWeight),
    /** Túi đá thợ trả giữa khâu (đổi size): TL / viên — đã trừ khỏi đá phát cho thợ. */
    stoneReturnedEarlyWeight: early.weight.gt(0) ? decStr(early.weight) : null,
    stoneReturnedEarlyCount: early.count || null,
    /** Từng dòng NVL đã xuất vào khâu — lúc giao hay thợ xin thêm, đủ để in lên phiếu. */
    issuedLines: requests
      .filter((request) => request.status === MaterialRequestStatus.ISSUED)
      .map((request) => ({
        atHandover: request.atHandover,
        sku: request.material.sku,
        name: request.material.name,
        unit: request.material.unit.name,
        kind: request.kind,
        qty: dec(request.issuedQty),
        weight: dec(request.issuedWeight),
        stoneCount: request.issuedStoneCount,
      })),
    pendingRequestCount: requests.filter(
      (request) => request.status === MaterialRequestStatus.PENDING,
    ).length,
    /** Bạc vào khâu = TL giao + bạc xuất thêm. */
    silverIn: dec(silverIn),
    craftsmanUserId: entry.craftsmanUserId,
    craftsmanName: entry.craftsmanName,
    submittedAt: entry.submittedAt?.toISOString() ?? null,
    submittedByName: entry.submittedByName,
    /** Báo lỗi ngay ở khâu đang làm: người báo, lúc báo và lý do. */
    defectReportedAt: entry.defectReportedAt?.toISOString() ?? null,
    defectReportedByName: entry.defectReportedByName,
    defectNote: entry.defectNote,
    returnedByName: entry.returnedByName,
    returnedAt: entry.returnedAt?.toISOString() ?? null,
    returnedQty: entry.returnedQty,
    returnedSilverWeight: dec(entry.returnedSilverWeight),
    stoneCount: entry.stoneCount,
    stoneWeight: dec(entry.stoneWeight),
    returnedStoneCount: entry.returnedStoneCount,
    /** Khâu Vào đá của phiếu con: đá giữ chỗ theo mã — QC cân gói thừa từng mã. */
    stoneLines: stoneLinesOf(
      holds.filter((hold) => hold.stageEntryId === entry.id),
    ),
    btpRecoveredWeight: dec(entry.btpRecoveredWeight),
    silverRecoveredWeight: dec(entry.silverRecoveredWeight),
    /** Nguội / Vào đá: QC tách hàng lỗi (SL), S999 thừa; thủ kho xác nhận rồi mới nhập kho. */
    defectQty: entry.defectQty,
    defectReason: entry.defectReason,
    scrapS999Weight: dec(entry.scrapS999Weight),
    confirmedAt: entry.confirmedAt?.toISOString() ?? null,
    confirmedByName: entry.confirmedByName,
    /** Số lần QC đã sửa lại kết quả (tối đa 3 trước khi thủ kho xác nhận). */
    kcsRevisionCount: entry.kcsRevisionCount,
    outputMaterialId: entry.outputMaterialId,
    silverLoss: dec(silverLoss),
    silverLossPercent: dec(lossPercentOf(silverLoss, silverIn)),
    /** Đá vào khâu = đá phát lúc giao + đá xuất thêm (viên). */
    stonesIn: stone.stonesIn,
    stoneLoss: stone.loss,
    stoneLossPercent:
      stone.loss != null && stone.stonesIn
        ? decStr(
            new Prisma.Decimal(stone.loss)
              .div(stone.stonesIn)
              .mul(100)
              .toDecimalPlaces(2),
          )
        : null,
    laborCost: dec(entry.laborCost),
    note: entry.note,
  };
}

/**
 * NVL đã xuất cho một phiếu (con hoặc mẹ) và hao hụt cả phiếu. Chỉ các khâu QC đã nhận lại
 * mới vào phần hao hụt: bạc vào = TL giao ở khâu đầu + bạc xuất thêm ở các khâu đó; hao hụt =
 * tổng hao hụt từng khâu. Đá tính theo viên.
 */
export function ticketMaterials(
  entries: readonly StageEntry[],
  requests: readonly MaterialRequest[],
  holds: readonly StoneHold[] = [],
) {
  const issuedRequests = requests.filter(
    (request) => request.status === MaterialRequestStatus.ISSUED,
  );
  const lines = new Map<
    string,
    {
      materialId: string;
      sku: string | null;
      name: string;
      unit: string;
      kind: MaterialRequestKind;
      qty: Prisma.Decimal;
      weight: Prisma.Decimal | null;
      stoneCount: number | null;
      times: number;
    }
  >();
  for (const request of issuedRequests) {
    const key = `${request.materialId}:${request.kind}`;
    const line = lines.get(key) ?? {
      materialId: request.materialId,
      sku: request.material.sku,
      name: request.material.name,
      unit: request.material.unit.name,
      kind: request.kind,
      qty: new Prisma.Decimal(0),
      weight: null,
      stoneCount: null,
      times: 0,
    };
    line.qty = line.qty.add(request.issuedQty ?? 0);
    if (request.issuedWeight != null) {
      line.weight = (line.weight ?? new Prisma.Decimal(0)).add(
        request.issuedWeight,
      );
    }
    if (request.issuedStoneCount != null) {
      line.stoneCount = (line.stoneCount ?? 0) + request.issuedStoneCount;
    }
    line.times += 1;
    lines.set(key, line);
  }

  const zero = new Prisma.Decimal(0);
  // Bạc vào phiếu tính cả khâu đang làm (để thấy ngay phần đã xuất); % hao hụt chỉ so trên
  // các khâu QC đã nhận lại, vì khâu dở dang chưa có số cân lại.
  let silverIn: Prisma.Decimal | null = null;
  let returnedBase: Prisma.Decimal | null = null;
  let silverLoss: Prisma.Decimal | null = null;
  let stonesIn = 0;
  let stoneLoss: number | null = null;
  entries.forEach((entry, index) => {
    const own = requests.filter((request) => request.stageEntryId === entry.id);
    const issued = issuedOf(own);
    // Khâu đầu lấy TL giao làm mốc; các khâu sau TL giao chính là hàng của khâu trước.
    const base = index === 0 ? silverInOf(entry, issued.metal) : issued.metal;
    if (base != null) silverIn = (silverIn ?? zero).add(base);
    if (!entry.returnedAt) return;
    if (base != null) returnedBase = (returnedBase ?? zero).add(base);
    const loss = silverLossOf(entry, issued.metal);
    if (loss != null) silverLoss = (silverLoss ?? zero).add(loss);
    const stone = stoneLossOf(
      entry,
      issued.stones - earlyReturnedOf(holds, entry.id).count,
    );
    stonesIn += stone.stonesIn ?? 0;
    if (stone.loss != null) stoneLoss = (stoneLoss ?? 0) + stone.loss;
  });

  return {
    lines: [...lines.values()].map((line) => ({
      ...line,
      qty: decStr(line.qty),
      weight: dec(line.weight),
    })),
    issuedMetalWeight: decStr(issuedOf(issuedRequests).metal),
    issuedStoneCount: issuedOf(issuedRequests).stones,
    pendingCount: requests.filter(
      (request) => request.status === MaterialRequestStatus.PENDING,
    ).length,
    silverIn: dec(silverIn),
    silverLoss: dec(silverLoss),
    silverLossPercent: dec(lossPercentOf(silverLoss, returnedBase)),
    stonesIn: stonesIn || null,
    stoneLoss,
    stoneLossPercent:
      stoneLoss != null && stonesIn > 0
        ? decStr(
            new Prisma.Decimal(stoneLoss)
              .div(stonesIn)
              .mul(100)
              .toDecimalPlaces(2),
          )
        : null,
  };
}

export function toMaterialRequest(
  request: MaterialRequest,
  orderCode: string,
  subTicketNo: number | null,
  stage: ProductionStage | null,
  ticketCount?: number,
) {
  return {
    id: request.id,
    orderCode,
    subTicketNo,
    ticketCode:
      subTicketNo != null
        ? subTicketCode(orderCode, subTicketNo, ticketCount)
        : orderCode,
    stageEntryId: request.stageEntryId,
    stage,
    status: request.status,
    kind: request.kind,
    /** Xuất ngay lúc giao khâu (không qua thợ xin). */
    atHandover: request.atHandover,
    material: {
      id: request.material.id,
      sku: request.material.sku,
      name: request.material.name,
      unit: request.material.unit.name,
      warehouseCode: request.material.warehouse.code,
      warehouseName: request.material.warehouse.shortName,
    },
    requestedQty: decStr(request.requestedQty),
    note: request.note,
    requestedByUserId: request.requestedByUserId,
    requestedByName: request.requestedByName,
    requestedAt: request.requestedAt.toISOString(),
    issuedQty: dec(request.issuedQty),
    issuedWeight: dec(request.issuedWeight),
    issuedStoneCount: request.issuedStoneCount,
    /** Đá xin thêm ở Vào đá: HELD đang giữ chỗ (chưa xuất) · CONSUMED đã xuất · RELEASED thừa hết. */
    holdStatus: request.stoneHold?.status ?? null,
    handledByName: request.handledByName,
    handledAt: request.handledAt?.toISOString() ?? null,
    rejectReason: request.rejectReason,
  };
}

export function requireStage(order: OrderDetail, stageId: string) {
  const entry = order.stages.find((item) => item.id === stageId);
  if (!entry) throw new NotFoundException('Không tìm thấy khâu trên đơn');
  return entry;
}

export function requireSubTicket(order: OrderDetail, no: number) {
  const ticket = order.subTickets.find((item) => item.no === no);
  if (!ticket) {
    throw new NotFoundException(
      `Không tìm thấy phiếu con ${subTicketCode(order.code, no)}`,
    );
  }
  return ticket;
}

/**
 * Đơn NVL vào Nguội khi thủ kho đã xác nhận phiếu đúc và cân phôi (`cutAt`). Đơn cũ nhập tay
 * đi theo ngày báo Đúc / Đúc về. Đơn BTP lấy hàng đúc sẵn.
 */
export function assertCastingReady(
  order: Pick<
    OrderDetail,
    'source' | 'castingSentDate' | 'castingReturnedDate' | 'cutAt'
  >,
  message: string,
) {
  if (
    order.source === 'NVL' &&
    !order.cutAt &&
    (!order.castingSentDate || !order.castingReturnedDate)
  ) {
    throw new BadRequestException(message);
  }
}

export function decimalOrNull(value: string | null | undefined) {
  return value != null && value !== '' ? new Prisma.Decimal(value) : null;
}

export function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

export function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function actorName(actor: { fullName: string; username: string }) {
  return actor.fullName.trim() || actor.username;
}
