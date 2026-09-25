import { Prisma, ProductionStage } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { actorName, type StageEntry, type SubTicket } from './order-detail';

/**
 * Mã thao tác ghi vào nhật ký. Giữ ổn định vì FE dịch sang tiếng Việt theo mã này — thêm mã
 * mới được, đừng đổi tên mã cũ.
 */
export const ACTIVITY = {
  ORDER_CREATE: 'ORDER_CREATE',
  ORDER_UPDATE: 'ORDER_UPDATE',
  ORDER_DELETE: 'ORDER_DELETE',
  ORDER_STATUS: 'ORDER_STATUS',
  ORDER_CASTING: 'ORDER_CASTING',
  ORDER_FINISH: 'ORDER_FINISH',
  ORDER_UNDO_FINISH: 'ORDER_UNDO_FINISH',
  ORDER_PRINT: 'ORDER_PRINT',
  COST_ADD: 'COST_ADD',
  COST_UPDATE: 'COST_UPDATE',
  COST_DELETE: 'COST_DELETE',
  STAGE_OPEN: 'STAGE_OPEN',
  STAGE_CANCEL_OPEN: 'STAGE_CANCEL_OPEN',
  STAGE_CLAIM: 'STAGE_CLAIM',
  STAGE_UNCLAIM: 'STAGE_UNCLAIM',
  STAGE_HANDOVER: 'STAGE_HANDOVER',
  STAGE_HANDOVER_EDIT: 'STAGE_HANDOVER_EDIT',
  STAGE_SUBMIT: 'STAGE_SUBMIT',
  STAGE_UNSUBMIT: 'STAGE_UNSUBMIT',
  STAGE_RETURN: 'STAGE_RETURN',
  STAGE_UNDO_RETURN: 'STAGE_UNDO_RETURN',
  STAGE_LABOR: 'STAGE_LABOR',
  TICKET_SPLIT: 'TICKET_SPLIT',
  TICKET_CREATE: 'TICKET_CREATE',
  TICKET_UPDATE: 'TICKET_UPDATE',
  TICKET_DELETE: 'TICKET_DELETE',
  TICKET_CLEAR_SPLIT: 'TICKET_CLEAR_SPLIT',
  /** Mã cũ của luồng "Cấp thêm" đã bỏ — giữ để nhật ký cũ vẫn đọc được. */
  TICKET_TOP_UP: 'TICKET_TOP_UP',
  MATERIAL_REQUEST: 'MATERIAL_REQUEST',
  MATERIAL_CANCEL: 'MATERIAL_CANCEL',
  MATERIAL_ISSUE: 'MATERIAL_ISSUE',
  MATERIAL_REJECT: 'MATERIAL_REJECT',
  TICKET_OUTCOME: 'TICKET_OUTCOME',
  TICKET_CLEAR_OUTCOME: 'TICKET_CLEAR_OUTCOME',
  TICKET_PRINT: 'TICKET_PRINT',
} as const;

export type ActivityAction = (typeof ACTIVITY)[keyof typeof ACTIVITY];

type ActivityInput = {
  orderCode: string;
  subTicketNo?: number | null;
  stage?: ProductionStage | null;
  before?: unknown;
  after?: unknown;
  note?: string | null;
};

/**
 * Một dòng nhật ký, dạng dùng được cho cả `activityLogs: { create }` lồng trong update đơn
 * lẫn `tx.productionActivityLog.create({ data: { orderId, ... } })`.
 */
export function activity(
  actor: AuthUserPayload,
  action: ActivityAction,
  input: ActivityInput,
) {
  return {
    orderCode: input.orderCode,
    subTicketNo: input.subTicketNo ?? null,
    stage: input.stage ?? null,
    action,
    actorUserId: actor.id,
    actorName: actorName(actor),
    before: toJson(input.before),
    after: toJson(input.after),
    note: input.note?.trim() || null,
  };
}

/** Ghi nhật ký trong transaction đang chạy. */
export async function logActivity(
  tx: Prisma.TransactionClient,
  orderId: string,
  actor: AuthUserPayload,
  action: ActivityAction,
  input: ActivityInput,
) {
  await tx.productionActivityLog.create({
    data: { orderId, ...activity(actor, action, input) },
  });
}

/** Các số của một lần giao khâu — chụp lại trước khi sửa / gỡ để còn đối chiếu. */
export function entrySnapshot(entry: StageEntry) {
  return {
    attempt: entry.attempt,
    craftsmanName: entry.craftsmanName,
    handedByName: entry.handedByName,
    handedAt: entry.handedAt,
    handedQty: entry.handedQty,
    handedSilverWeight: entry.handedSilverWeight,
    handedStoneCount: entry.handedStoneCount,
    handedStoneWeight: entry.handedStoneWeight,
    submittedByName: entry.submittedByName,
    submittedAt: entry.submittedAt,
    returnedByName: entry.returnedByName,
    returnedAt: entry.returnedAt,
    returnedQty: entry.returnedQty,
    returnedSilverWeight: entry.returnedSilverWeight,
    stoneCount: entry.stoneCount,
    stoneWeight: entry.stoneWeight,
    returnedStoneCount: entry.returnedStoneCount,
    btpRecoveredWeight: entry.btpRecoveredWeight,
    silverRecoveredWeight: entry.silverRecoveredWeight,
    laborCost: entry.laborCost,
    note: entry.note,
  };
}

/** Các số của một phiếu con — chụp lại trước khi sửa / xoá. */
export function ticketSnapshot(ticket: SubTicket) {
  return {
    no: ticket.no,
    qty: ticket.qty,
    note: ticket.note,
    pendingStage: ticket.pendingStage,
    pendingByName: ticket.pendingByName,
    claimedByName: ticket.claimedByName,
    outcome: ticket.outcome,
    outcomeStage: ticket.outcomeStage,
    outcomeQty: ticket.outcomeQty,
    outcomeByName: ticket.outcomeByName,
    outcomeNote: ticket.outcomeNote,
  };
}

/**
 * Decimal / Date → chuỗi, bỏ trường undefined. Prisma chỉ nhận JSON thuần; null giữ nguyên
 * nghĩa "trống", còn cả khối không có thì để DB null.
 */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
