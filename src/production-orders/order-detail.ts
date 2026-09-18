import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, ProductionStage, ProductionStatus } from '@prisma/client';
import { decStr } from '../util/money';
import { silverLossOf } from './stage-math';

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
  statusLogs: { orderBy: { changedAt: 'desc' } },
  parent: {
    select: {
      code: true,
      children: { select: { id: true }, orderBy: { seq: 'asc' } },
    },
  },
  children: { select: { code: true, status: true }, orderBy: { seq: 'asc' } },
  receipt: true,
  btpMaterial: { select: { id: true, sku: true, name: true } },
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

export function subTicketState(
  ticket: Pick<SubTicket, 'pendingStage' | 'claimedByUserId' | 'outcome'>,
  entries: StageEntry[],
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
 * Số lượng / bạc phiếu con đang có để giao khâu sau: đúng số KCS nhận lại ở khâu gần nhất,
 * chưa làm khâu nào thì là phần đã chia.
 */
export function subTicketAvailable(
  ticket: Pick<SubTicket, 'qty' | 'silverWeight'>,
  entries: StageEntry[],
) {
  const last = entries[entries.length - 1];
  if (!last) return { qty: ticket.qty, silver: ticket.silverWeight };
  if (last.returnedAt) {
    return {
      qty: last.returnedQty ?? last.handedQty ?? ticket.qty,
      silver: last.returnedSilverWeight ?? ticket.silverWeight,
    };
  }
  return {
    qty: last.handedQty ?? ticket.qty,
    silver: last.handedSilverWeight ?? ticket.silverWeight,
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

  return {
    id: order.id,
    code: order.code,
    status: order.status,
    source: order.source,
    btp: order.btpMaterial,
    btpSku: order.btpMaterial?.sku ?? null,
    requestType: order.requestType,
    qty: order.qty,
    returnedQty: order.returnedQty,
    model3dCode: order.model3dCode,
    model3dUrl: order.model3dUrl,
    leadTime: order.leadTime,
    trackingCode: order.trackingCode,
    closedBy: order.closedBy,
    description: order.description,
    stoneColor: order.stoneColor,
    stoneTypes: order.stoneTypes,
    stoneCount: order.stoneCount,
    stoneWeight: order.stoneWeight != null ? decStr(order.stoneWeight) : null,
    silverWeight:
      order.silverWeight != null ? decStr(order.silverWeight) : null,
    size: order.size,
    sizeLabel: order.sizeLabel,
    mainMaterial: order.mainMaterial,
    platingColor: order.platingColor,
    laserEngraving: order.laserEngraving,
    otherRequirements: order.otherRequirements,
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
          qty: order.receipt.qty,
          receivedAt: order.receipt.receivedAt.toISOString(),
          receivedByName: order.receipt.receivedByName,
          shippedQty: order.shipmentLines.reduce(
            (sum, line) => sum + line.qty,
            0,
          ),
          remainingQty:
            order.receipt.qty -
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
      ),
    ),
    subTickets: order.subTickets.map((ticket) => toSubTicket(order, ticket)),
    subTicketTotals: {
      qty: order.subTickets.reduce((sum, ticket) => sum + ticket.qty, 0),
      silverWeight: decStr(
        order.subTickets.reduce(
          (sum, ticket) => sum.add(ticket.silverWeight),
          new Prisma.Decimal(0),
        ),
      ),
    },
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
    silverWeight: decStr(ticket.silverWeight),
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
    outcome: ticket.outcome,
    outcomeAt: ticket.outcomeAt?.toISOString() ?? null,
    outcomeByName: ticket.outcomeByName,
    outcomeStage: ticket.outcomeStage,
    outcomeQty: ticket.outcomeQty,
    outcomeNote: ticket.outcomeNote,
    availableQty: available.qty,
    availableSilver: decStr(available.silver),
    lastPrintedAt: ticket.lastPrintedAt?.toISOString() ?? null,
    createdByName: ticket.createdByName,
    createdAt: ticket.createdAt.toISOString(),
  };
}

export function toStage(entry: StageEntry, subTicketNo: number | null = null) {
  const silverLoss = silverLossOf(entry);
  const silverLossPercent =
    silverLoss != null &&
    entry.handedSilverWeight != null &&
    entry.handedSilverWeight.gt(0)
      ? silverLoss.div(entry.handedSilverWeight).mul(100).toDecimalPlaces(2)
      : null;
  const dec = (value: Prisma.Decimal | null) =>
    value != null ? decStr(value) : null;

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
    craftsmanUserId: entry.craftsmanUserId,
    craftsmanName: entry.craftsmanName,
    submittedAt: entry.submittedAt?.toISOString() ?? null,
    submittedByName: entry.submittedByName,
    returnedByName: entry.returnedByName,
    returnedAt: entry.returnedAt?.toISOString() ?? null,
    returnedQty: entry.returnedQty,
    returnedSilverWeight: dec(entry.returnedSilverWeight),
    btpRecoveredWeight: dec(entry.btpRecoveredWeight),
    silverRecoveredWeight: dec(entry.silverRecoveredWeight),
    silverLoss: dec(silverLoss),
    silverLossPercent: dec(silverLossPercent),
    laborCost: dec(entry.laborCost),
    note: entry.note,
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
