import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProductionStage,
  ProductionStatus,
  RoleCode,
  SubTicketOutcome,
} from '@prisma/client';
import { userHasRole } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { dbTable } from '../prisma/database-url';
import { PrismaService } from '../prisma/prisma.service';
import { decStr } from '../util/money';
import {
  HandoverInfoDto,
  OpenOrderStageDto,
  OpenSubTicketStageDto,
  SplitSubTicketsDto,
  SubTicketDto,
  SubTicketOutcomeDto,
  SubTicketTopUpDto,
} from './dto/production-order.dto';
import {
  actorName,
  assertCastingReady,
  detailInclude,
  entriesOf,
  handedStoneOf,
  IN_STAGE_STATUSES,
  LAST_STAGE,
  lastStageDone,
  normalizeCode,
  openOrderEntry,
  orderEntries,
  orderTicketAvailable,
  orderTicketState,
  type OrderDetail,
  requireSubTicket,
  slowestStage,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_STATUS,
  type StageEntry,
  type SubTicket,
  subTicketAvailable,
  subTicketCode,
  subTicketState,
  ticketPosition,
  toDetail,
} from './order-detail';
import { silverLossOf } from './stage-math';

const S = ProductionStatus;

const RECENT_LIMIT = 20;
const AVAILABLE_LIMIT = 100;

const CLEAR_PENDING = {
  pendingStage: null,
  pendingAt: null,
  pendingByName: null,
  claimedByUserId: null,
  claimedByName: null,
  claimedAt: null,
} satisfies Prisma.ProductionSubTicketUpdateInput;

const CLEAR_ORDER_PENDING = {
  pendingStage: null,
  pendingAt: null,
  pendingByName: null,
  claimedByUserId: null,
  claimedByName: null,
  claimedAt: null,
} satisfies Prisma.ProductionOrderUpdateInput;

const myTicketInclude = {
  order: {
    select: {
      code: true,
      status: true,
      description: true,
      dueDate: true,
      images: {
        select: { url: true },
        orderBy: [{ kind: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
      },
    },
  },
  stages: { orderBy: { createdAt: 'asc' } },
  topUps: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      qty: true,
      silverWeight: true,
      stageEntryId: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ProductionSubTicketInclude;

type MyTicketRow = Prisma.ProductionSubTicketGetPayload<{
  include: typeof myTicketInclude;
}>;

/**
 * Phiếu con cho thợ: người lên đơn chia số lượng + gram bạc, mở khâu cho thợ tự nhận,
 * người giao xác nhận giao rồi KCS nhận lại như khâu thường (dùng chung returnStage).
 */
@Injectable()
export class ProductionSubTicketsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mở khâu trên phiếu mẹ; thợ sẽ thấy ở "Phiếu của tôi" và tự nhận. */
  async openOrderStage(
    code: string,
    dto: OpenOrderStageDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      assertCastingReady(
        order,
        'Ghi ngày báo Đúc và ngày Đúc về trước khi mở khâu cho thợ',
      );
      if (order.subTickets.length > 0) {
        throw new BadRequestException(
          'Đơn đã chia phiếu con — mở khâu trên từng phiếu con',
        );
      }
      const entries = orderEntries(order);
      const { state } = orderTicketState(order, entries);
      if (state !== 'IDLE') {
        throw new BadRequestException(
          `Phiếu mẹ ${order.code} đang ${STATE_LABEL[state]}, chưa mở khâu mới được`,
        );
      }
      const last = lastOf(entries);
      const reworking = !IN_STAGE_STATUSES.includes(order.status);
      if (
        last &&
        !reworking &&
        STAGE_ORDER.indexOf(dto.stage) <= STAGE_ORDER.indexOf(last.stage)
      ) {
        throw new BadRequestException(
          `Khâu mới phải sau khâu ${STAGE_LABEL[last.stage]}. Muốn làm lại, chuyển đơn sang Sản xuất lỗi trước.`,
        );
      }
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          pendingStage: dto.stage,
          pendingAt: new Date(),
          pendingByName: actorName(actor),
          claimedByUserId: null,
          claimedByName: null,
          claimedAt: null,
          dataChangedAt: new Date(),
        },
      });
    });
  }

  async cancelOrderPending(code: string) {
    return this.mutate(code, async (tx, order) => {
      const { state } = orderTicketState(order, orderEntries(order));
      if (state !== 'WAITING' && state !== 'CLAIMED') {
        throw new BadRequestException(
          `Phiếu mẹ ${order.code} không có khâu đang chờ nhận`,
        );
      }
      await tx.productionOrder.update({
        where: { id: order.id },
        data: { ...CLEAR_ORDER_PENDING, dataChangedAt: new Date() },
      });
    });
  }

  async claimOrder(code: string, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      if (order.subTickets.length > 0) {
        throw new BadRequestException('Đơn đã chia phiếu con');
      }
      const { state } = orderTicketState(order, orderEntries(order));
      if (state === 'CLAIMED') {
        throw new BadRequestException(
          order.claimedByUserId === actor.id
            ? `Bạn đã nhận phiếu ${order.code}`
            : `Phiếu ${order.code} đã có thợ ${order.claimedByName ?? ''} nhận`,
        );
      }
      if (state !== 'WAITING') {
        throw new BadRequestException(
          `Phiếu ${order.code} đang ${STATE_LABEL[state]}, chưa nhận được`,
        );
      }
      const { count } = await tx.productionOrder.updateMany({
        where: {
          id: order.id,
          pendingStage: order.pendingStage,
          claimedByUserId: null,
        },
        data: {
          claimedByUserId: actor.id,
          claimedByName: actorName(actor),
          claimedAt: new Date(),
          dataChangedAt: new Date(),
        },
      });
      if (count === 0) {
        throw new BadRequestException('Phiếu đã có thợ khác nhận');
      }
    });
  }

  async unclaimOrder(code: string, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      const { state } = orderTicketState(order, orderEntries(order));
      if (state !== 'CLAIMED') {
        throw new BadRequestException(`Phiếu ${order.code} chưa có thợ nhận`);
      }
      if (order.claimedByUserId !== actor.id && !canManage(order, actor)) {
        throw new ForbiddenException(
          'Chỉ thợ đã nhận, người lên đơn hoặc admin được gỡ lượt nhận',
        );
      }
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          claimedByUserId: null,
          claimedByName: null,
          claimedAt: null,
          dataChangedAt: new Date(),
        },
      });
    });
  }

  /** Người giao xác nhận số lượng/bạc cho thợ đã tự nhận phiếu mẹ. */
  async handoverOrder(
    code: string,
    dto: HandoverInfoDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      assertCastingReady(
        order,
        'Ghi ngày báo Đúc và ngày Đúc về trước khi giao khâu cho thợ',
      );
      const entries = orderEntries(order);
      const { state } = orderTicketState(order, entries);
      const stage = order.pendingStage;
      if (state !== 'CLAIMED' || !stage || !order.claimedByUserId) {
        throw new BadRequestException(
          `Phiếu ${order.code} chưa có thợ nhận khâu nào để giao`,
        );
      }
      if (order.claimedByUserId === actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Thợ không tự xác nhận giao cho mình — nhờ người giao cân bạc và xác nhận',
        );
      }
      const craftsman = await tx.user.findFirst({
        where: { id: order.claimedByUserId, isActive: true },
        select: { id: true, fullName: true, username: true },
      });
      if (!craftsman) {
        throw new BadRequestException(
          'Tài khoản thợ đã nhận phiếu không còn hoạt động — gỡ lượt nhận để thợ khác nhận',
        );
      }
      const available = orderTicketAvailable(order, entries);
      const handedQty = dto.handedQty ?? available.qty;
      if (handedQty > available.qty) {
        throw new BadRequestException(
          `Số lượng giao không được nhiều hơn số phiếu đang có (${available.qty})`,
        );
      }
      const handedAt = new Date(dto.handedAt);
      const previous = lastOf(entries);
      if (previous?.returnedAt && handedAt < previous.returnedAt) {
        throw new BadRequestException(
          'Thời gian giao không được trước lúc KCS nhận lại khâu trước',
        );
      }
      const craftsmanName = actorName(craftsman);
      const changedBy = actorName(actor);
      const nextStatus = STAGE_STATUS[stage];
      await tx.productionStageEntry.create({
        data: {
          orderId: order.id,
          stage,
          attempt: entries.filter((entry) => entry.stage === stage).length + 1,
          handedByUserId: actor.id,
          handedByName: changedBy,
          handedAt,
          handedQty,
          handedSilverWeight: new Prisma.Decimal(dto.handedSilverWeight),
          ...handedStoneOf(stage, dto, order),
          craftsmanUserId: craftsman.id,
          craftsmanName,
          note: dto.note?.trim() || null,
        },
      });
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          ...CLEAR_ORDER_PENDING,
          status: nextStatus,
          dataChangedAt: new Date(),
          statusLogs:
            order.status === nextStatus
              ? undefined
              : {
                  create: {
                    fromStatus: order.status,
                    toStatus: nextStatus,
                    note: `Giao ${STAGE_LABEL[stage]} cho ${craftsmanName} (phiếu mẹ ${order.code})`,
                    changedBy,
                  },
                },
        },
      });
    });
  }

  async submitOrder(code: string, actor: AuthUserPayload) {
    return this.setOrderSubmitted(code, actor, true);
  }

  async unsubmitOrder(code: string, actor: AuthUserPayload) {
    return this.setOrderSubmitted(code, actor, false);
  }

  private setOrderSubmitted(
    code: string,
    actor: AuthUserPayload,
    submitted: boolean,
  ) {
    return this.mutate(code, async (tx, order) => {
      const open = openOrderEntry(order);
      if (!open || (submitted ? open.submittedAt : !open.submittedAt)) {
        throw new BadRequestException(
          submitted
            ? `Phiếu ${order.code} không có khâu đang làm hoặc đã báo xong`
            : `Phiếu ${order.code} chưa báo xong khâu nào`,
        );
      }
      if (open.craftsmanUserId !== actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          submitted
            ? 'Chỉ thợ đang giữ khâu này mới báo xong được'
            : 'Chỉ thợ đã báo xong hoặc admin mới gỡ được',
        );
      }
      await tx.productionStageEntry.update({
        where: { id: open.id },
        data: submitted
          ? {
              submittedAt: new Date(),
              submittedByUserId: actor.id,
              submittedByName: actorName(actor),
            }
          : {
              submittedAt: null,
              submittedByUserId: null,
              submittedByName: null,
            },
      });
      await touch(tx, order.id);
    });
  }

  /**
   * Chia đơn lần đầu. Hai phiếu được tạo trong cùng transaction nên hệ thống không bao giờ
   * để lại một phiếu con đơn lẻ nếu request thứ hai lỗi hoặc mất mạng.
   */
  async split(code: string, dto: SplitSubTicketsDto, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertManager(order, actor);
      assertOrderActive(order);
      assertCastingReady(
        order,
        'Ghi ngày báo Đúc và ngày Đúc về trước khi chia phiếu con',
      );
      if (order.subTickets.length > 0) {
        throw new BadRequestException('Đơn đã được chia phiếu con');
      }
      if (order.pendingStage) {
        throw new BadRequestException(
          `Phiếu mẹ đang mở khâu ${STAGE_LABEL[order.pendingStage]} — hủy mở khâu trước khi chia phiếu con`,
        );
      }
      const open = openOrderEntry(order);
      if (open) {
        throw new BadRequestException(
          `Khâu ${STAGE_LABEL[open.stage]} của cả đơn chưa được KCS nhận lại, chưa chia phiếu con được`,
        );
      }
      // Đơn đã chạy trên phiếu mẹ thì các khâu đã làm thuộc cả đơn, không thuộc phiếu con
      // nào — chia lúc này phiếu con sẽ mất lịch sử. Khâu đã giao không xoá được nên đơn này
      // đi tiếp trên phiếu mẹ.
      const parentStage = lastOf(orderEntries(order));
      if (parentStage) {
        throw new BadRequestException(
          `Đơn đã giao khâu ${STAGE_LABEL[parentStage.stage]} trên phiếu mẹ — làm tiếp trên phiếu mẹ, không chia phiếu con được nữa`,
        );
      }
      const rows = dto.tickets.map((ticket) => ({
        ...ticket,
        silver: positiveSilver(ticket.silverWeight),
      }));
      const totalQty = rows.reduce((sum, ticket) => sum + ticket.qty, 0);
      const totalSilver = rows.reduce(
        (sum, ticket) => sum.add(ticket.silver),
        new Prisma.Decimal(0),
      );
      assertWithinTotals(order, totalQty, totalSilver);

      const firstNo = order.subTicketSeq + 1;
      const name = actorName(actor);
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          subTicketSeq: order.subTicketSeq + rows.length,
          dataChangedAt: new Date(),
        },
      });
      await tx.productionSubTicket.createMany({
        data: rows.map((ticket, index) => ({
          orderId: order.id,
          no: firstNo + index,
          qty: ticket.qty,
          silverWeight: ticket.silver,
          note: ticket.note?.trim() || null,
          createdByUserId: actor.id,
          createdByName: name,
        })),
      });
    });
  }

  async create(code: string, dto: SubTicketDto, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertManager(order, actor);
      assertOrderActive(order);
      assertCastingReady(
        order,
        'Ghi ngày báo Đúc và ngày Đúc về trước khi chia phiếu con',
      );
      if (order.subTickets.length === 0) {
        throw new BadRequestException(
          'Lần chia đầu tiên phải tạo ít nhất 2 phiếu con',
        );
      }
      const open = openOrderEntry(order);
      if (open) {
        throw new BadRequestException(
          `Khâu ${STAGE_LABEL[open.stage]} của cả đơn chưa được KCS nhận lại, chưa chia phiếu con được`,
        );
      }
      const silver = positiveSilver(dto.silverWeight);
      assertWithinTotals(order, dto.qty, silver);

      // Phiếu mới đi cùng khâu các phiếu con khác đang làm, nếu chúng đang cùng một khâu.
      const stage = currentStage(order);
      const no = order.subTicketSeq + 1;
      const name = actorName(actor);
      await tx.productionOrder.update({
        where: { id: order.id },
        data: { subTicketSeq: no, dataChangedAt: new Date() },
      });
      await tx.productionSubTicket.create({
        data: {
          orderId: order.id,
          no,
          qty: dto.qty,
          silverWeight: silver,
          note: dto.note?.trim() || null,
          pendingStage: stage,
          pendingAt: stage ? new Date() : null,
          pendingByName: stage ? name : null,
          createdByUserId: actor.id,
          createdByName: name,
        },
      });
    });
  }

  async update(
    code: string,
    no: number,
    dto: SubTicketDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertManager(order, actor);
      assertOrderActive(order);
      const ticket = requireSubTicket(order, no);
      const silver = positiveSilver(dto.silverWeight);
      const changed =
        dto.qty !== ticket.qty || !silver.equals(ticket.silverWeight);
      if (changed && entriesOf(order, ticket.id).length > 0) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã giao khâu, không đổi số lượng / gram được`,
        );
      }
      // Số lượng / gram của phiếu đã cộng phần cấp thêm; ghi đè ở đây là xoá sổ phần
      // vật tư đã giao thật cho thợ, trong khi lịch sử cấp thêm vẫn ghi là có.
      if (changed && ticket.topUps.length > 0) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã được cấp thêm, không đổi số lượng / gram được`,
        );
      }
      assertWithinTotals(order, dto.qty, silver, ticket.id);
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: {
          qty: dto.qty,
          silverWeight: silver,
          note: dto.note?.trim() || null,
        },
      });
      await touch(tx, order.id);
    });
  }

  /** Hủy toàn bộ phép chia trước khi bắt đầu sản xuất, đưa đơn về luồng phiếu mẹ. */
  async clearSplit(code: string, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertManager(order, actor);
      assertOrderActive(order);
      if (order.subTickets.length === 0) {
        throw new BadRequestException('Đơn chưa chia phiếu con');
      }
      const started = order.subTickets.find(
        (ticket) =>
          entriesOf(order, ticket.id).length > 0 ||
          ticket.topUps.length > 0 ||
          ticket.outcome ||
          ticket.pendingStage ||
          ticket.claimedByUserId,
      );
      if (started) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, started)} đã mở hoặc bắt đầu làm, không hủy chia được`,
        );
      }
      await tx.productionSubTicket.deleteMany({ where: { orderId: order.id } });
      await touch(tx, order.id);
    });
  }

  async remove(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertManager(order, actor);
      const ticket = requireSubTicket(order, no);
      if (order.subTickets.length === 2) {
        throw new BadRequestException(
          'Không thể để lại đúng 1 phiếu con; hãy giữ cả hai hoặc hủy chia phiếu',
        );
      }
      if (entriesOf(order, ticket.id).length > 0) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã giao khâu, không xoá được`,
        );
      }
      // Cấp thêm có thể đã nâng tổng của đơn; xoá phiếu đi thì tổng đơn treo lại ở mức
      // cao mà không còn gì giải thích, sau đó chia được nhiều hơn mức từng dự kiến.
      if (ticket.topUps.length > 0) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã được cấp thêm vật tư, không xoá được`,
        );
      }
      await tx.productionSubTicket.delete({ where: { id: ticket.id } });
      await touch(tx, order.id);
    });
  }

  /** Mở một khâu cho thợ tự nhận. Mỗi lúc cả đơn chỉ làm một khâu. */
  async openStage(
    code: string,
    dto: OpenSubTicketStageDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      assertCastingReady(
        order,
        'Ghi ngày báo Đúc và ngày Đúc về trước khi mở khâu cho thợ',
      );
      if (order.subTickets.length < 2) {
        throw new BadRequestException(
          'Chỉ mở khâu theo phiếu con khi đơn có từ 2 phiếu trở lên',
        );
      }
      // Mỗi phiếu con đi khâu của riêng nó: phiếu nào xong trước thì mở khâu sau cho phiếu
      // đó luôn, không phải đợi các phiếu còn lại. Trạng thái đơn theo phần chậm nhất —
      // xem slowestStage.
      const rows = order.subTickets.map((ticket) => ({
        ticket,
        entries: entriesOf(order, ticket.id),
        ...subTicketState(ticket, entriesOf(order, ticket.id)),
      }));
      const targets = dto.nos?.length
        ? unique(dto.nos).map((no) => {
            const ticket = requireSubTicket(order, no);
            return rows.find((row) => row.ticket.id === ticket.id)!;
          })
        : rows.filter((row) => row.state === 'IDLE');
      if (targets.length === 0) {
        throw new BadRequestException('Không còn phiếu con nào chờ mở khâu');
      }

      // Được bỏ qua khâu nhưng không lùi khâu, trừ khi đơn đã ra khỏi khâu để làm lại.
      const reworking = !IN_STAGE_STATUSES.includes(order.status);
      const orderLast = lastOf(
        order.stages.filter((entry) => !entry.subTicketId),
      );
      for (const row of targets) {
        if (row.state !== 'IDLE') {
          throw new BadRequestException(
            `Phiếu ${ticketCode(order, row.ticket)} đang ${STATE_LABEL[row.state]}`,
          );
        }
        const last = lastOf(row.entries) ?? orderLast;
        if (
          last &&
          !reworking &&
          STAGE_ORDER.indexOf(dto.stage) <= STAGE_ORDER.indexOf(last.stage)
        ) {
          throw new BadRequestException(
            `Phiếu ${ticketCode(order, row.ticket)} đã qua khâu ${STAGE_LABEL[last.stage]} — khâu mới phải sau khâu đó. Muốn làm lại, chuyển đơn sang Sản xuất lỗi trước.`,
          );
        }
      }

      await tx.productionSubTicket.updateMany({
        where: { id: { in: targets.map((row) => row.ticket.id) } },
        data: {
          ...CLEAR_PENDING,
          pendingStage: dto.stage,
          pendingAt: new Date(),
          pendingByName: actorName(actor),
        },
      });
    });
  }

  /** Huỷ khâu đang mở (kể cả khi thợ đã nhận nhưng chưa được giao). */
  async cancelPending(code: string, no: number) {
    return this.mutate(code, async (tx, order) => {
      const ticket = requireSubTicket(order, no);
      const { state } = subTicketState(ticket, entriesOf(order, ticket.id));
      if (state !== 'WAITING' && state !== 'CLAIMED') {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} không có khâu đang chờ nhận`,
        );
      }
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: CLEAR_PENDING,
      });
    });
  }

  /** Thợ tự nhận khâu đang mở của phiếu con. */
  async claim(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      const ticket = requireSubTicket(order, no);
      const { state } = subTicketState(ticket, entriesOf(order, ticket.id));
      if (state === 'CLAIMED') {
        throw new BadRequestException(
          ticket.claimedByUserId === actor.id
            ? `Bạn đã nhận phiếu ${ticketCode(order, ticket)}`
            : `Phiếu ${ticketCode(order, ticket)} đã có thợ ${ticket.claimedByName ?? ''} nhận`,
        );
      }
      if (state !== 'WAITING') {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đang ${STATE_LABEL[state]}, chưa nhận được`,
        );
      }
      // Đơn đã khoá trong transaction; điều kiện chỉ để chắc không đè lượt nhận khác.
      const { count } = await tx.productionSubTicket.updateMany({
        where: {
          id: ticket.id,
          pendingStage: ticket.pendingStage,
          claimedByUserId: null,
        },
        data: {
          claimedByUserId: actor.id,
          claimedByName: actorName(actor),
          claimedAt: new Date(),
        },
      });
      if (count === 0) {
        throw new BadRequestException('Phiếu đã có thợ khác nhận');
      }
    });
  }

  /** Bỏ lượt nhận khi chưa được giao: chính thợ đó, người lên đơn hoặc admin. */
  async unclaim(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      const ticket = requireSubTicket(order, no);
      const { state } = subTicketState(ticket, entriesOf(order, ticket.id));
      if (state !== 'CLAIMED') {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa có thợ nhận`,
        );
      }
      if (ticket.claimedByUserId !== actor.id && !canManage(order, actor)) {
        throw new ForbiddenException(
          'Chỉ thợ đã nhận, người lên đơn hoặc admin được gỡ lượt nhận',
        );
      }
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: {
          claimedByUserId: null,
          claimedByName: null,
          claimedAt: null,
        },
      });
    });
  }

  /** Người giao cân bạc và xác nhận giao khâu cho thợ đã nhận phiếu. */
  async handover(
    code: string,
    no: number,
    dto: HandoverInfoDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      assertCastingReady(
        order,
        'Ghi ngày báo Đúc và ngày Đúc về trước khi giao khâu cho thợ',
      );
      const ticket = requireSubTicket(order, no);
      const entries = entriesOf(order, ticket.id);
      const { state } = subTicketState(ticket, entries);
      const stage = ticket.pendingStage;
      if (state !== 'CLAIMED' || !stage || !ticket.claimedByUserId) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa có thợ nhận khâu nào để giao`,
        );
      }
      // Cân bạc lúc giao cần hai người: người giao và thợ nhận. Riêng admin được tự xác
      // nhận cho mình — bản ghi khâu vẫn ghi người giao = thợ nên xem lại vẫn biết lần đó
      // chỉ có một người cân.
      if (ticket.claimedByUserId === actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Thợ không tự xác nhận giao cho mình — nhờ người giao cân bạc và xác nhận',
        );
      }
      const craftsman = await tx.user.findFirst({
        where: { id: ticket.claimedByUserId, isActive: true },
        select: { id: true, fullName: true, username: true },
      });
      if (!craftsman) {
        throw new BadRequestException(
          'Tài khoản thợ đã nhận phiếu không còn hoạt động — gỡ lượt nhận để thợ khác nhận',
        );
      }
      const available = subTicketAvailable(ticket, entries, ticket.topUps);
      const handedQty = dto.handedQty ?? available.qty;
      if (handedQty > available.qty) {
        throw new BadRequestException(
          `Số lượng giao không được nhiều hơn số phiếu con đang có (${available.qty})`,
        );
      }
      const handedAt = new Date(dto.handedAt);
      const previous = lastOf(entries);
      if (previous?.returnedAt && handedAt < previous.returnedAt) {
        throw new BadRequestException(
          'Thời gian giao không được trước lúc KCS nhận lại khâu trước',
        );
      }

      const craftsmanName = actorName(craftsman);
      const changedBy = actorName(actor);
      // Phiếu con đi lệch khâu nhau nên không đặt trạng thái đơn theo phiếu vừa giao —
      // phiếu nhanh giao Vào đá trong khi phiếu khác còn Nguội thì đơn vẫn là Nguội.
      const orderLast =
        lastOf(order.stages.filter((entry) => !entry.subTicketId))?.stage ??
        null;
      const nextStatus =
        STAGE_STATUS[
          slowestStage(
            order.subTickets.map((other) =>
              other.id === ticket.id
                ? stage
                : ticketPosition(other, entriesOf(order, other.id), orderLast),
            ),
          ) ?? stage
        ];
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: CLEAR_PENDING,
      });
      const created = await tx.productionStageEntry.create({
        data: {
          orderId: order.id,
          subTicketId: ticket.id,
          stage,
          attempt: entries.filter((entry) => entry.stage === stage).length + 1,
          handedByUserId: actor.id,
          handedByName: changedBy,
          handedAt,
          handedQty,
          handedSilverWeight: new Prisma.Decimal(dto.handedSilverWeight),
          ...handedStoneOf(stage, dto, order),
          craftsmanUserId: craftsman.id,
          craftsmanName,
          note: dto.note?.trim() || null,
        },
      });
      // Phần cấp thêm lúc phiếu đang rảnh nay đã nằm trong số giao của khâu này.
      await tx.productionSubTicketTopUp.updateMany({
        where: { subTicketId: ticket.id, stageEntryId: null },
        data: { stageEntryId: created.id },
      });
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          status: nextStatus,
          dataChangedAt: new Date(),
          statusLogs:
            order.status === nextStatus
              ? undefined
              : {
                  create: {
                    fromStatus: order.status,
                    toStatus: nextStatus,
                    note: `Giao ${STAGE_LABEL[stage]} cho ${craftsmanName} (phiếu ${ticketCode(order, ticket)})`,
                    changedBy,
                  },
                },
        },
      });
    });
  }

  /**
   * Chốt phiếu con ở một trong hai nhánh cuối phiếu: Lỗi (bắt buộc lý do) hoặc Hoàn thiện.
   * Chỉ chốt khi phiếu không còn khâu đang chạy — KCS cân lại xong mới phán đạt / lỗi.
   */
  async setOutcome(
    code: string,
    no: number,
    outcome: SubTicketOutcome,
    dto: SubTicketOutcomeDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      if (order.status === S.DELIVERED) {
        throw new BadRequestException('Đơn đã giao');
      }
      const ticket = requireSubTicket(order, no);
      if (ticket.outcome) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã chốt ${OUTCOME_LABEL[ticket.outcome]}`,
        );
      }
      const entries = entriesOf(order, ticket.id);
      const { state } = subTicketState(ticket, entries);
      if (state !== 'IDLE') {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đang ${STATE_LABEL[state]} — xong khâu rồi mới chốt được`,
        );
      }
      if (outcome === SubTicketOutcome.FINISH && entries.length === 0) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa làm khâu nào, chưa hoàn thiện được`,
        );
      }
      if (outcome === SubTicketOutcome.FINISH && !lastStageDone(entries)) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa xong khâu ${STAGE_LABEL[LAST_STAGE]} — làm hết phiếu rồi mới hoàn thiện được`,
        );
      }
      const note = dto.note?.trim() || null;
      if (outcome === SubTicketOutcome.DEFECT && !note) {
        throw new BadRequestException('Ghi lý do lỗi');
      }

      const available = subTicketAvailable(ticket, entries, ticket.topUps);
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: {
          ...CLEAR_PENDING,
          outcome,
          outcomeAt: new Date(),
          outcomeByUserId: actor.id,
          outcomeByName: actorName(actor),
          outcomeStage: lastOf(entries)?.stage ?? null,
          outcomeQty:
            outcome === SubTicketOutcome.FINISH ? available.qty : null,
          outcomeNote: note,
        },
      });
      await this.syncOrder(tx, order, actor);
    });
  }

  /** Admin gỡ kết cục để sửa sai: phiếu về lại luồng làm, đơn tính lại trạng thái và kho. */
  async clearOutcome(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      const ticket = requireSubTicket(order, no);
      if (!ticket.outcome) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa chốt lỗi / hoàn thiện`,
        );
      }
      if (order.shipmentLines.length > 0) {
        throw new BadRequestException(
          'Đơn đã có phiếu xuất hàng, xóa phiếu xuất trước khi gỡ kết cục phiếu con',
        );
      }
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: {
          outcome: null,
          outcomeAt: null,
          outcomeByUserId: null,
          outcomeByName: null,
          outcomeStage: null,
          outcomeQty: null,
          outcomeNote: null,
        },
      });
      await this.syncOrder(tx, order, actor);
    });
  }

  /**
   * Gộp kết cục các phiếu con lên đơn mẹ. Số của phiếu hoàn thiện cộng dồn ngay vào phiếu
   * nhập kho thành phẩm; trạng thái đơn chỉ chốt khi mọi phiếu con đã có kết cục —
   * còn ít nhất một phiếu hoàn thiện thì đơn Hoàn thiện, tất cả lỗi thì đơn Sản xuất lỗi.
   */
  private async syncOrder(
    tx: Prisma.TransactionClient,
    order: OrderDetail,
    actor: AuthUserPayload,
  ) {
    // Đọc lại từ DB: `order` là bản trước khi chốt / gỡ kết cục trong transaction này.
    const tickets = await tx.productionSubTicket.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        qty: true,
        outcome: true,
        outcomeQty: true,
        pendingStage: true,
        claimedByUserId: true,
      },
    });
    const finished = tickets.filter(
      (ticket) => ticket.outcome === SubTicketOutcome.FINISH,
    );
    const finishedQty = finished.reduce(
      (sum, ticket) => sum + (ticket.outcomeQty ?? ticket.qty),
      0,
    );
    const changedBy = actorName(actor);

    if (finishedQty > 0) {
      await tx.finishedGoodsReceipt.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          qty: finishedQty,
          receivedAt: new Date(),
          receivedByUserId: actor.id,
          receivedByName: changedBy,
        },
        update: { qty: finishedQty },
      });
    } else if (order.receipt) {
      await tx.finishedGoodsReceipt.delete({ where: { orderId: order.id } });
    }

    const done =
      tickets.length > 0 && tickets.every((ticket) => ticket.outcome != null);
    let status = order.status;
    let note: string | null = null;
    if (done) {
      status = finishedQty > 0 ? S.FINISHING : S.DEFECT;
      note = `${finished.length}/${tickets.length} phiếu con hoàn thiện — ${finishedQty} sp vào kho thành phẩm`;
    } else if (order.status === S.FINISHING || order.status === S.DEFECT) {
      // Gỡ kết cục một phiếu: đơn quay lại khâu của phần chậm nhất còn đang làm — không lấy
      // khâu mới tạo gần nhất, vì phiếu con đi lệch khâu nhau thì đó là khâu của phiếu nhanh.
      const orderLast =
        lastOf(order.stages.filter((entry) => !entry.subTicketId))?.stage ??
        null;
      const stage = slowestStage(
        tickets.map((ticket) =>
          ticketPosition(ticket, entriesOf(order, ticket.id), orderLast),
        ),
      );
      status = stage ? STAGE_STATUS[stage] : S.CASTING;
      note = 'Gỡ kết cục phiếu con — đơn quay lại sản xuất';
    }

    if (status === order.status) {
      await touch(tx, order.id);
      return;
    }
    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        status,
        dataChangedAt: new Date(),
        statusLogs: {
          create: {
            fromStatus: order.status,
            toStatus: status,
            note,
            changedBy,
          },
        },
      },
    });
  }

  /**
   * Chi tiết đơn xem từ một phiếu con. Trang phiếu con dùng đường này thay vì đi qua
   * endpoint đơn mẹ, nhờ vậy màn quản lý đơn chặn được tài khoản thợ.
   */
  async detailByTicket(ticketCode: string) {
    const parsed = parseTicketCode(ticketCode);
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: parsed?.orderCode ?? normalizeCode(ticketCode) },
      include: detailInclude,
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    if (parsed) {
      // Ném 404 nếu phiếu con không tồn tại trên đơn.
      requireSubTicket(order, parsed.no);
    } else if (order.subTickets.length > 0) {
      throw new BadRequestException(
        'Đơn đã chia phiếu con — quét mã phiếu con để nhận việc',
      );
    }
    return toDetail(order);
  }

  /**
   * Thợ báo đã làm xong khâu đang giữ và nộp hàng cho KCS. Chỉ là tín hiệu để KCS biết
   * phiếu nào tới lượt mình — KCS vẫn nhận lại được cả khi thợ chưa bấm.
   */
  async submit(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      const ticket = requireSubTicket(order, no);
      const entries = entriesOf(order, ticket.id);
      const open = entries.find((entry) => !entry.returnedAt);
      if (!open) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} không có khâu nào đang làm`,
        );
      }
      if (open.submittedAt) {
        throw new BadRequestException(
          `Khâu ${STAGE_LABEL[open.stage]} đã được báo xong lúc ${open.submittedAt.toLocaleString('vi-VN')}`,
        );
      }
      // Dấu vết của một hành động người thật: chỉ chính thợ đang giữ khâu được bấm.
      if (open.craftsmanUserId !== actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Chỉ thợ đang giữ khâu này mới báo xong được',
        );
      }
      await tx.productionStageEntry.update({
        where: { id: open.id },
        data: {
          submittedAt: new Date(),
          submittedByUserId: actor.id,
          submittedByName: actorName(actor),
        },
      });
      await touch(tx, order.id);
    });
  }

  /** Bấm nhầm thì bỏ báo xong — chính thợ đó hoặc admin, khi KCS chưa nhận lại. */
  async unsubmit(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      const ticket = requireSubTicket(order, no);
      const entries = entriesOf(order, ticket.id);
      const open = entries.find((entry) => !entry.returnedAt);
      if (!open?.submittedAt) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa báo xong khâu nào`,
        );
      }
      if (open.craftsmanUserId !== actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Chỉ thợ đã báo xong hoặc admin mới gỡ được',
        );
      }
      await tx.productionStageEntry.update({
        where: { id: open.id },
        data: {
          submittedAt: null,
          submittedByUserId: null,
          submittedByName: null,
        },
      });
      await touch(tx, order.id);
    });
  }

  /**
   * Cấp thêm số lượng / bạc cho phiếu con khi thợ làm giữa chừng phát hiện thiếu.
   *
   * Đang có khâu mở thì cộng thẳng vào số giao của khâu đó — nếu không, công thức hao hụt
   * (giao − nhận lại − thu hồi) sẽ ra số âm. Phiếu đang rảnh thì phần này vào khâu kế tiếp.
   * Vượt tổng của đơn thì nâng tổng đơn theo, vì đơn thực tế tốn nhiều hơn dự kiến.
   */
  async topUp(
    code: string,
    no: number,
    dto: SubTicketTopUpDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      const ticket = requireSubTicket(order, no);
      if (ticket.outcome) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã chốt ${OUTCOME_LABEL[ticket.outcome]}, không cấp thêm được`,
        );
      }
      const addQty = dto.qty ?? 0;
      const addSilver = new Prisma.Decimal(dto.silverWeight ?? '0');
      if (addQty < 0 || addSilver.lt(0)) {
        throw new BadRequestException('Số cấp thêm không được âm');
      }
      if (addQty === 0 && addSilver.isZero()) {
        throw new BadRequestException('Nhập số lượng hoặc gram bạc cấp thêm');
      }

      const entries = entriesOf(order, ticket.id);
      const open = entries.find((entry) => !entry.returnedAt);
      const changedBy = actorName(actor);

      // Phiếu con giữ tổng đã cấp; số đang có trong tay tính ở subTicketAvailable.
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: {
          qty: ticket.qty + addQty,
          silverWeight: ticket.silverWeight.add(addSilver),
        },
      });
      if (open) {
        await tx.productionStageEntry.update({
          where: { id: open.id },
          data: {
            handedQty: (open.handedQty ?? 0) + addQty,
            handedSilverWeight: (
              open.handedSilverWeight ?? new Prisma.Decimal(0)
            ).add(addSilver),
          },
        });
      }
      await tx.productionSubTicketTopUp.create({
        data: {
          subTicketId: ticket.id,
          stageEntryId: open?.id ?? null,
          qty: addQty,
          silverWeight: addSilver,
          reason: dto.reason?.trim() || null,
          createdByUserId: actor.id,
          createdByName: changedBy,
        },
      });

      await this.raiseOrderTotals(
        tx,
        order,
        addQty,
        addSilver,
        changedBy,
        ticket,
      );
    });
  }

  /** Tổng phiếu con vượt tổng đơn thì nâng tổng đơn lên vừa đủ và ghi vào lịch sử trạng thái. */
  private async raiseOrderTotals(
    tx: Prisma.TransactionClient,
    order: OrderDetail,
    addQty: number,
    addSilver: Prisma.Decimal,
    changedBy: string,
    ticket: SubTicket,
  ) {
    const totalQty =
      order.subTickets.reduce((sum, item) => sum + item.qty, 0) + addQty;
    const totalSilver = order.subTickets
      .reduce((sum, item) => sum.add(item.silverWeight), new Prisma.Decimal(0))
      .add(addSilver);

    const nextQty = Math.max(order.qty, totalQty);
    const nextSilver =
      order.silverWeight == null || order.silverWeight.lt(totalSilver)
        ? totalSilver
        : order.silverWeight;
    const raised =
      nextQty !== order.qty ||
      !nextSilver.equals(order.silverWeight ?? nextSilver);

    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        qty: nextQty,
        silverWeight: nextSilver,
        dataChangedAt: new Date(),
        statusLogs: raised
          ? {
              create: {
                fromStatus: order.status,
                toStatus: order.status,
                note: `Cấp thêm cho phiếu ${ticketCode(order, ticket)} vượt dự kiến — đơn nâng lên ${nextQty} sp · ${decStr(nextSilver)} g bạc`,
                changedBy,
              },
            }
          : undefined,
      },
    });
  }

  async markPrinted(code: string, no: number) {
    const ticket = await this.prisma.productionSubTicket.findFirst({
      where: { no, order: { code: normalizeCode(code) } },
      select: {
        id: true,
        order: { select: { source: true, castingSentDate: true } },
      },
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu con');
    if (ticket.order.source === 'NVL' && !ticket.order.castingSentDate) {
      throw new BadRequestException('Chỉ in phiếu thợ khi đơn đã báo Đúc');
    }
    const updated = await this.prisma.productionSubTicket.update({
      where: { id: ticket.id },
      data: { lastPrintedAt: new Date() },
      select: { lastPrintedAt: true },
    });
    return { lastPrintedAt: updated.lastPrintedAt?.toISOString() ?? null };
  }

  /** Màn "Phiếu của tôi": phiếu đang mở chờ nhận, phiếu mình đang giữ, phiếu vừa nộp. */
  async myTickets(actor: AuthUserPayload) {
    const [available, claimed, working, recent, parentOrders] =
      await Promise.all([
      this.prisma.productionSubTicket.findMany({
        where: {
          pendingStage: { not: null },
          claimedByUserId: null,
          order: { status: { not: S.DELIVERED } },
        },
        include: myTicketInclude,
        orderBy: { pendingAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionSubTicket.findMany({
        where: { claimedByUserId: actor.id, pendingStage: { not: null } },
        include: myTicketInclude,
        orderBy: { claimedAt: 'asc' },
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          craftsmanUserId: actor.id,
          subTicketId: { not: null },
          returnedAt: null,
        },
        include: { subTicket: { include: myTicketInclude } },
        orderBy: { handedAt: 'asc' },
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          craftsmanUserId: actor.id,
          subTicketId: { not: null },
          returnedAt: { not: null },
        },
        include: { subTicket: { include: myTicketInclude } },
        orderBy: { returnedAt: 'desc' },
        take: RECENT_LIMIT,
      }),
      this.prisma.productionOrder.findMany({
        where: {
          subTickets: { none: {} },
          OR: [
            { pendingStage: { not: null } },
            {
              stages: {
                some: { craftsmanUserId: actor.id, subTicketId: null },
              },
            },
          ],
        },
        include: detailInclude,
        orderBy: { updatedAt: 'desc' },
        take: AVAILABLE_LIMIT,
      }),
    ]);

    const parentAvailable = parentOrders.filter(
      (order) => order.pendingStage && !order.claimedByUserId,
    );
    const parentClaimed = parentOrders.filter(
      (order) =>
        order.pendingStage && order.claimedByUserId === actor.id,
    );
    const parentEntries = parentOrders.flatMap((order) =>
      orderEntries(order).map((entry) => ({ order, entry })),
    );
    const parentWorking = parentEntries.filter(
      ({ entry }) =>
        entry.craftsmanUserId === actor.id && entry.returnedAt == null,
    );
    const parentRecent = parentEntries
      .filter(
        ({ entry }) =>
          entry.craftsmanUserId === actor.id && entry.returnedAt != null,
      )
      .sort(
        (a, b) =>
          (b.entry.returnedAt?.getTime() ?? 0) -
          (a.entry.returnedAt?.getTime() ?? 0),
      )
      .slice(0, RECENT_LIMIT);

    return {
      available: [
        ...parentAvailable.map((order) => parentPendingItem(order)),
        ...available.map((row) => pendingItem(row)),
      ],
      mine: [
        ...parentClaimed.map((order) => parentPendingItem(order)),
        ...parentWorking.map(({ order, entry }) =>
          parentEntryItem(order, entry),
        ),
        ...claimed.map((row) => pendingItem(row)),
        ...working.flatMap((entry) =>
          entry.subTicket ? [entryItem(entry.subTicket, entry)] : [],
        ),
      ],
      recent: [
        ...parentRecent.map(({ order, entry }) =>
          parentEntryItem(order, entry),
        ),
        ...recent.flatMap((entry) =>
          entry.subTicket ? [entryItem(entry.subTicket, entry)] : [],
        ),
      ].slice(0, RECENT_LIMIT),
    };
  }

  /**
   * Khoá dòng đơn trong cả transaction rồi đọc lại đơn: mọi kiểm tra tổng số lượng / gram,
   * trạng thái phiếu con chạy trên dữ liệu mới nhất, hai người thao tác cùng lúc không đè nhau.
   */
  private async mutate(
    code: string,
    apply: (tx: Prisma.TransactionClient, order: OrderDetail) => Promise<void>,
  ) {
    const found = await this.prisma.productionOrder.findUnique({
      where: { code: normalizeCode(code) },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    const updated = await this.prisma.runTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ${dbTable('production_orders')} WHERE id = ${found.id}::uuid FOR UPDATE`;
      const order = await tx.productionOrder.findUniqueOrThrow({
        where: { id: found.id },
        include: detailInclude,
      });
      await apply(tx, order);
      return found.id;
    });
    return toDetail(
      await this.prisma.productionOrder.findUniqueOrThrow({
        where: { id: updated },
        include: detailInclude,
      }),
    );
  }
}

const STATE_LABEL = {
  IDLE: 'chờ mở khâu',
  WAITING: 'chờ thợ nhận',
  CLAIMED: 'chờ người giao xác nhận',
  WORKING: 'được thợ làm, chờ KCS nhận lại',
  SUBMITTED: 'thợ đã báo xong, chờ KCS cân lại',
  DEFECT: 'đã chốt lỗi',
  FINISH: 'đã hoàn thiện',
} as const;

const OUTCOME_LABEL: Record<SubTicketOutcome, string> = {
  DEFECT: 'lỗi',
  FINISH: 'hoàn thiện',
};

function isAdmin(actor: AuthUserPayload) {
  return userHasRole(actor.roleCode, actor.extraRoles ?? [], RoleCode.ADMIN);
}

function canManage(
  order: Pick<OrderDetail, 'createdByUserId'>,
  actor: AuthUserPayload,
) {
  return (
    userHasRole(actor.roleCode, actor.extraRoles ?? [], RoleCode.ADMIN) ||
    (order.createdByUserId != null && order.createdByUserId === actor.id)
  );
}

function assertManager(
  order: Pick<OrderDetail, 'createdByUserId'>,
  actor: AuthUserPayload,
) {
  if (!canManage(order, actor)) {
    throw new ForbiddenException(
      'Chỉ người lên đơn hoặc admin được chia phiếu con',
    );
  }
}

function assertOrderActive(order: OrderDetail) {
  if (order.status === S.DELIVERED) {
    throw new BadRequestException('Đơn đã giao');
  }
  // Có phiếu nhập kho nhưng còn phiếu con đang chạy là chuyện bình thường: phần hoàn thiện
  // vào kho ngay, phần còn lại vẫn làm tiếp. Chỉ chặn khi cả đơn đã chốt.
  if (order.receipt && !order.subTickets.some((ticket) => !ticket.outcome)) {
    throw new BadRequestException(
      'Đơn đã hoàn thiện và vào kho thành phẩm — chuyển sang Sản xuất lỗi trước nếu cần làm lại',
    );
  }
}

function positiveSilver(value: string) {
  const silver = new Prisma.Decimal(value);
  if (silver.lte(0)) {
    throw new BadRequestException('Gram bạc của phiếu con phải lớn hơn 0');
  }
  return silver;
}

/** Tổng các phiếu con không vượt số lượng đơn và Tổng TL bạc. */
function assertWithinTotals(
  order: OrderDetail,
  qty: number,
  silver: Prisma.Decimal,
  exceptId?: string,
) {
  if (order.silverWeight == null) {
    throw new BadRequestException(
      'Nhập Tổng TL bạc của đơn trước khi chia phiếu con',
    );
  }
  const others = order.subTickets.filter((ticket) => ticket.id !== exceptId);
  const totalQty = others.reduce((sum, ticket) => sum + ticket.qty, qty);
  const totalSilver = others.reduce(
    (sum, ticket) => sum.add(ticket.silverWeight),
    silver,
  );
  if (totalQty > order.qty) {
    throw new BadRequestException(
      `Tổng số lượng phiếu con (${totalQty}) vượt số lượng đơn (${order.qty})`,
    );
  }
  if (totalSilver.gt(order.silverWeight)) {
    throw new BadRequestException(
      `Tổng gram phiếu con (${decStr(totalSilver)} g) vượt Tổng TL bạc của đơn (${decStr(order.silverWeight)} g)`,
    );
  }
}

/**
 * Khâu chung mà các phiếu con đang chờ nhận / đang làm. Phiếu con được đi lệch khâu nhau
 * nên có thể không có khâu chung — lúc đó trả null, phiếu mới để rảnh cho người lên đơn tự
 * chọn khâu thay vì đoán theo phiếu nào đó.
 */
function currentStage(order: OrderDetail) {
  const active = new Set(
    order.subTickets
      .map(
        (ticket) =>
          subTicketState(ticket, entriesOf(order, ticket.id)).activeStage,
      )
      .filter((stage): stage is ProductionStage => stage != null),
  );
  return active.size === 1 ? [...active][0] : null;
}

/** Tách mã phiếu con "A012-2" → đơn A012, phiếu số 2. */
function parseTicketCode(value: string) {
  const match = /^(.+)-(\d+)$/.exec(normalizeCode(value));
  if (!match) return null;
  return { orderCode: match[1], no: Number(match[2]) };
}

function ticketCode(order: Pick<OrderDetail, 'code'>, ticket: SubTicket) {
  return subTicketCode(order.code, ticket.no);
}

function touch(tx: Prisma.TransactionClient, orderId: string) {
  return tx.productionOrder.update({
    where: { id: orderId },
    data: { dataChangedAt: new Date() },
  });
}

function lastOf<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

function unique(values: number[]) {
  return Array.from(new Set(values));
}

function baseItem(row: MyTicketRow) {
  return {
    scope: 'SUB_TICKET' as const,
    ticketCode: subTicketCode(row.order.code, row.no),
    orderCode: row.order.code,
    no: row.no,
    orderStatus: row.order.status,
    description: row.order.description,
    dueDate: row.order.dueDate?.toISOString().slice(0, 10) ?? null,
    imageUrl: row.order.images[0]?.url ?? null,
  };
}

function parentBaseItem(order: OrderDetail) {
  return {
    scope: 'ORDER' as const,
    ticketCode: order.code,
    orderCode: order.code,
    no: null,
    orderStatus: order.status,
    description: order.description,
    dueDate: order.dueDate?.toISOString().slice(0, 10) ?? null,
    imageUrl: order.images[0]?.url ?? null,
  };
}

function parentPendingItem(order: OrderDetail) {
  const entries = orderEntries(order);
  const { state } = orderTicketState(order, entries);
  const available = orderTicketAvailable(order, entries);
  return {
    ...parentBaseItem(order),
    state,
    stage: order.pendingStage,
    qty: available.qty,
    silverWeight:
      available.silver != null ? decStr(available.silver) : null,
    pendingAt: order.pendingAt?.toISOString() ?? null,
    claimedAt: order.claimedAt?.toISOString() ?? null,
    submittedAt: null,
    handedAt: null,
    handedByName: null,
    returnedAt: null,
    returnedByName: null,
    returnedSilverWeight: null,
    silverLoss: null,
  };
}

function parentEntryItem(order: OrderDetail, entry: StageEntry) {
  const loss = silverLossOf(entry);
  return {
    ...parentBaseItem(order),
    state: entry.returnedAt
      ? null
      : entry.submittedAt
        ? ('SUBMITTED' as const)
        : ('WORKING' as const),
    submittedAt: entry.submittedAt?.toISOString() ?? null,
    stage: entry.stage,
    qty: entry.handedQty ?? order.qty,
    silverWeight:
      entry.handedSilverWeight != null
        ? decStr(entry.handedSilverWeight)
        : null,
    pendingAt: null,
    claimedAt: null,
    handedAt: entry.handedAt.toISOString(),
    handedByName: entry.handedByName,
    returnedAt: entry.returnedAt?.toISOString() ?? null,
    returnedByName: entry.returnedByName,
    returnedSilverWeight:
      entry.returnedSilverWeight != null
        ? decStr(entry.returnedSilverWeight)
        : null,
    silverLoss: loss != null ? decStr(loss) : null,
  };
}

function pendingItem(row: MyTicketRow) {
  const { state } = subTicketState(row, row.stages);
  const available = subTicketAvailable(row, row.stages, row.topUps);
  return {
    ...baseItem(row),
    state,
    stage: row.pendingStage,
    qty: available.qty,
    silverWeight: decStr(available.silver),
    pendingAt: row.pendingAt?.toISOString() ?? null,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    submittedAt: null,
    handedAt: null,
    handedByName: null,
    returnedAt: null,
    returnedByName: null,
    returnedSilverWeight: null,
    silverLoss: null,
  };
}

function entryItem(row: MyTicketRow, entry: StageEntry) {
  const loss = silverLossOf(entry);
  return {
    ...baseItem(row),
    state: entry.returnedAt
      ? null
      : entry.submittedAt
        ? ('SUBMITTED' as const)
        : ('WORKING' as const),
    submittedAt: entry.submittedAt?.toISOString() ?? null,
    stage: entry.stage,
    qty: entry.handedQty ?? row.qty,
    silverWeight:
      entry.handedSilverWeight != null
        ? decStr(entry.handedSilverWeight)
        : null,
    pendingAt: null,
    claimedAt: null,
    handedAt: entry.handedAt.toISOString(),
    handedByName: entry.handedByName,
    returnedAt: entry.returnedAt?.toISOString() ?? null,
    returnedByName: entry.returnedByName,
    returnedSilverWeight:
      entry.returnedSilverWeight != null
        ? decStr(entry.returnedSilverWeight)
        : null,
    silverLoss: loss != null ? decStr(loss) : null,
  };
}
