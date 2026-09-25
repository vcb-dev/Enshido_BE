import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MaterialRequestKind,
  MaterialRequestStatus,
  Prisma,
  ProductionStage,
  ProductionStatus,
  SubTicketOutcome,
} from '@prisma/client';
import { decStr } from '../util/money';
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
  FILING: 'Nguội',
  STONE_SETTING: 'Vào đá',
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
  S.FILING,
  S.STONE_SETTING,
  S.ENGRAVING,
  S.POLISHING,
  S.PLATING,
];

export const detailInclude = {
  images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
  stages: { orderBy: { createdAt: 'asc' } },
  subTickets: { orderBy: { no: 'asc' } },
  materialRequests: {
    orderBy: { requestedAt: 'asc' },
    include: materialRequestMaterial(),
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
export type StageEntry = OrderDetail['stages'][number];
export type SubTicket = OrderDetail['subTickets'][number];
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
  } satisfies Prisma.ProductionMaterialRequestInclude;
}

/**
 * Phiếu con đang ở đâu trong khâu hiện tại:
 * IDLE chờ mở khâu · WAITING chờ thợ nhận · CLAIMED thợ đã nhận, chờ người giao xác nhận ·
 * WORKING đã giao, thợ đang làm · SUBMITTED thợ báo xong, chờ KCS cân lại ·
 * DEFECT / FINISH là hai nhánh kết thúc phiếu.
 */
export type SubTicketState =
  | 'IDLE'
  | 'WAITING'
  | 'CLAIMED'
  | 'WORKING'
  | 'SUBMITTED'
  | 'DEFECT'
  | 'FINISH';

export function subTicketCode(orderCode: string, no: number) {
  return `${orderCode}-${no}`;
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
        `Đơn chỉ còn ${decStr(left.lt(0) ? new Prisma.Decimal(0) : left)} g đá chưa giao`,
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
 * Phiếu đã đi hết đến khâu cuối chưa: khâu gần nhất phải là Xi và đã được KCS nhận lại. Chưa
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
type StateEntry = Pick<StageEntry, 'stage' | 'returnedAt' | 'submittedAt'>;

export function subTicketState(
  ticket: Pick<SubTicket, 'pendingStage' | 'claimedByUserId' | 'outcome'>,
  entries: readonly StateEntry[],
): { state: SubTicketState; activeStage: ProductionStage | null } {
  // Phiếu đã chốt lỗi / hoàn thiện thì không còn khâu nào chạy.
  if (ticket.outcome) return { state: ticket.outcome, activeStage: null };
  const open = entries.find((entry) => !entry.returnedAt);
  if (open) {
    return {
      state: open.submittedAt ? 'SUBMITTED' : 'WORKING',
      activeStage: open.stage,
    };
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
  for (const ticket of order.subTickets) {
    if (ticket.outcome === SubTicketOutcome.DEFECT) {
      statuses.add(S.DEFECT);
      continue;
    }
    if (ticket.outcome === SubTicketOutcome.FINISH) {
      statuses.add(S.FINISHING);
      continue;
    }
    const entries = order.stages.filter(
      (entry) => entry.subTicketId === ticket.id,
    );
    const stage = ticketPosition(ticket, entries);
    if (stage) statuses.add(STAGE_STATUS[stage]);
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
) {
  const { state, activeStage } = subTicketState(ticket, entries);
  const open = entries.find((entry) => !entry.returnedAt);
  return {
    code: subTicketCode(orderCode, ticket.no),
    no: ticket.no,
    qty: ticket.qty,
    note: ticket.note,
    createdAt: ticket.createdAt.toISOString(),
    state,
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
 * Phiếu con được đi lệch khâu nhau, nhưng đơn chỉ có một trạng thái: lấy khâu của phần chậm
 * nhất. Đơn đứng ở "Nguội" nghĩa là vẫn còn hàng chưa qua Nguội — không báo tiến độ vượt
 * quá phần hàng thật sự đã tới.
 */
export function slowestStage(
  stages: readonly (ProductionStage | null)[],
): ProductionStage | null {
  let slowest: ProductionStage | null = null;
  for (const stage of stages) {
    if (
      stage &&
      (slowest === null ||
        STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(slowest))
    ) {
      slowest = stage;
    }
  }
  return slowest;
}

/**
 * Số lượng / bạc phiếu con đang có trong tay để giao khâu kế tiếp.
 *
 * - Chưa làm khâu nào: phần đã chia; bạc chưa có — người giao cân lúc giao khâu đầu.
 * - Đang làm dở: số đã giao.
 * - Khâu trước xong rồi: số KCS trả lại.
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

/** Phiếu mẹ dùng cùng state machine chờ nhận → đã nhận → đang làm → chờ KCS như phiếu con. */
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

/** Khâu cấp đơn (không thuộc phiếu con) đang chờ KCS nhận lại. */
export function openOrderEntry(order: Pick<OrderDetail, 'stages'>) {
  return order.stages.find((entry) => !entry.subTicketId && !entry.returnedAt);
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
    stages: order.stages.map((entry) =>
      toStage(
        entry,
        entry.subTicketId ? (ticketNo.get(entry.subTicketId) ?? null) : null,
        requestsOf(order, entry.id),
      ),
    ),
    materialRequests: order.materialRequests.map((request) =>
      toMaterialRequest(
        request,
        order.code,
        request.subTicketId
          ? (ticketNo.get(request.subTicketId) ?? null)
          : null,
        order.stages.find((entry) => entry.id === request.stageEntryId)
          ?.stage ?? null,
      ),
    ),
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
            materials: ticketMaterials(parentEntries, order.materialRequests),
          }
        : null,
    subTickets: order.subTickets.map((ticket) => toSubTicket(order, ticket)),
    subTicketTotals: {
      qty: order.subTickets.reduce((sum, ticket) => sum + ticket.qty, 0),
    },
    /** NVL xuất thêm + hao hụt của cả đơn, cộng mọi phiếu. */
    materials: ticketMaterials(order.stages, order.materialRequests),
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
    code: subTicketCode(order.code, ticket.no),
    qty: ticket.qty,
    note: ticket.note,
    state,
    activeStage,
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
    ),
    outcome: ticket.outcome,
    outcomeAt: ticket.outcomeAt?.toISOString() ?? null,
    outcomeByName: ticket.outcomeByName,
    outcomeStage: ticket.outcomeStage,
    outcomeQty: ticket.outcomeQty,
    outcomeNote: ticket.outcomeNote,
    availableQty: available.qty,
    availableSilver: available.silver != null ? decStr(available.silver) : null,
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

export function toStage(
  entry: StageEntry,
  subTicketNo: number | null = null,
  requests: readonly MaterialRequest[] = [],
) {
  const issued = issuedOf(requests);
  const silverIn = silverInOf(entry, issued.metal);
  const silverLoss = silverLossOf(entry, issued.metal);
  const stone = stoneLossOf(entry, issued.stones);

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
    returnedByName: entry.returnedByName,
    returnedAt: entry.returnedAt?.toISOString() ?? null,
    returnedQty: entry.returnedQty,
    returnedSilverWeight: dec(entry.returnedSilverWeight),
    stoneCount: entry.stoneCount,
    stoneWeight: dec(entry.stoneWeight),
    returnedStoneCount: entry.returnedStoneCount,
    btpRecoveredWeight: dec(entry.btpRecoveredWeight),
    silverRecoveredWeight: dec(entry.silverRecoveredWeight),
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
 * NVL đã xuất cho một phiếu (con hoặc mẹ) và hao hụt cả phiếu. Chỉ các khâu KCS đã nhận lại
 * mới vào phần hao hụt: bạc vào = TL giao ở khâu đầu + bạc xuất thêm ở các khâu đó; hao hụt =
 * tổng hao hụt từng khâu. Đá tính theo viên.
 */
export function ticketMaterials(
  entries: readonly StageEntry[],
  requests: readonly MaterialRequest[],
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
  // các khâu KCS đã nhận lại, vì khâu dở dang chưa có số cân lại.
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
    const stone = stoneLossOf(entry, issued.stones);
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
) {
  return {
    id: request.id,
    orderCode,
    subTicketNo,
    ticketCode:
      subTicketNo != null ? subTicketCode(orderCode, subTicketNo) : orderCode,
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

/** Đơn NVL phải có đủ ngày báo Đúc / Đúc về mới giao thợ; đơn BTP lấy hàng đúc sẵn. */
export function assertCastingReady(
  order: Pick<
    OrderDetail,
    'source' | 'castingSentDate' | 'castingReturnedDate'
  >,
  message: string,
) {
  if (
    order.source === 'NVL' &&
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
