import { ForbiddenException } from '@nestjs/common';
import type { ProductionStage } from '@prisma/client';
import { isWorkerOnly } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';

type Work = {
  pendingStage: ProductionStage | null;
  claimedByUserId: string | null;
};

export type VisibilityOrder = Work & {
  subTickets: (Work & { id: string })[];
  stages: { subTicketId: string | null; craftsmanUserId: string | null }[];
};

/**
 * Thợ khâu xem được một phiếu khi: đang được giao / đã nhận phiếu đó, đã từng làm một khâu
 * trên phiếu, hoặc phiếu đang mở chờ đúng khâu của mình mà chưa ai nhận.
 */
function workerSeesTicket(
  order: VisibilityOrder,
  ticketId: string | null,
  work: Work,
  userId: string,
  stages: readonly ProductionStage[],
): boolean {
  if (work.claimedByUserId === userId) return true;
  if (
    order.stages.some(
      (entry) =>
        (entry.subTicketId ?? null) === ticketId &&
        entry.craftsmanUserId === userId,
    )
  ) {
    return true;
  }
  return (
    work.pendingStage != null &&
    work.claimedByUserId == null &&
    stages.includes(work.pendingStage)
  );
}

/** Các phiếu của đơn: từng phiếu con, hoặc chính phiếu mẹ khi đơn chưa chia. */
function ticketsOf(order: VisibilityOrder) {
  return order.subTickets.length
    ? order.subTickets.map((ticket) => ({ id: ticket.id, work: ticket }))
    : [{ id: null, work: order as Work }];
}

/**
 * Chặn thợ khâu xem phiếu không phải của mình (quét QR / gõ link). `subTicketId` = phiếu cụ
 * thể; bỏ trống = xem thông tin đơn, chỉ cần một phiếu trong đơn là của mình. Người không phải
 * thợ khâu (QC, thủ kho, thợ 3D / sáp / đúc, admin) không bị kiểm ở đây.
 */
export function assertWorkerCanView(
  order: VisibilityOrder,
  actor: AuthUserPayload,
  workerStages: readonly ProductionStage[],
  subTicketId?: string,
): void {
  if (!isWorkerOnly(actor.roleCode, actor.extraRoles, actor.allowedScreens)) {
    return;
  }
  const tickets = ticketsOf(order).filter(
    (ticket) => subTicketId === undefined || ticket.id === subTicketId,
  );
  const visible = tickets.some((ticket) =>
    workerSeesTicket(order, ticket.id, ticket.work, actor.id, workerStages),
  );
  if (!visible) {
    throw new ForbiddenException(
      'Phiếu này không phải của bạn — chỉ xem được phiếu mình được giao, đã làm, hoặc đang chờ khâu của mình',
    );
  }
}
