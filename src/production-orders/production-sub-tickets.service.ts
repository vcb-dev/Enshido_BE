import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MaterialRequestStatus,
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
  recentFirst,
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
import {
  ACTIVITY,
  activity,
  entrySnapshot,
  logActivity,
  ticketSnapshot,
} from './activity-log';
import { ProductionMaterialRequestsService } from './production-material-requests.service';
import {
  issuedOf,
  lossPercentOf,
  silverInOf,
  silverLossOf,
} from './stage-math';

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
} satisfies Prisma.ProductionSubTicketInclude;

/** NVL đã xuất / đang xin của một khâu — thợ xem mình đã nhận gì và tính hao hụt cho đúng. */
const entryRequestsSelect = {
  materialRequests: {
    where: {
      status: {
        in: [MaterialRequestStatus.ISSUED, MaterialRequestStatus.PENDING],
      },
    },
    orderBy: { requestedAt: 'asc' },
    select: {
      status: true,
      kind: true,
      atHandover: true,
      issuedQty: true,
      issuedWeight: true,
      issuedStoneCount: true,
      material: {
        select: { sku: true, name: true, unit: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.ProductionStageEntryInclude;

type EntryRequests = Prisma.ProductionStageEntryGetPayload<{
  include: typeof entryRequestsSelect;
}>['materialRequests'];

type MyTicketRow = Prisma.ProductionSubTicketGetPayload<{
  include: typeof myTicketInclude;
}>;

/**
 * Phiếu mẹ ở màn "Phiếu của tôi": chỉ những cột dựng nên một thẻ phiếu. Màn này thợ mở trên
 * điện thoại và tự làm mới liên tục, nên không kéo cả chi tiết đơn (ảnh, mọi khâu, phiếu con,
 * lịch sử trạng thái, dòng xuất hàng…) như `detailInclude`.
 */
const myOrderCardSelect = {
  id: true,
  code: true,
  status: true,
  description: true,
  qty: true,
  dueDate: true,
  images: {
    select: { url: true },
    orderBy: [{ kind: 'desc' }, { sortOrder: 'asc' }],
    take: 1,
  },
} satisfies Prisma.ProductionOrderSelect;

/** Thẻ phiếu mẹ đang chờ nhận còn cần SL / bạc còn lại, nên kèm các khâu đã chạy của đơn. */
const myOrderPendingSelect = {
  ...myOrderCardSelect,
  pendingStage: true,
  pendingAt: true,
  claimedByUserId: true,
  claimedAt: true,
  receipt: { select: { id: true } },
  stages: {
    where: { subTicketId: null },
    orderBy: { createdAt: 'asc' },
    select: {
      stage: true,
      submittedAt: true,
      returnedAt: true,
      handedQty: true,
      handedSilverWeight: true,
      returnedQty: true,
      returnedSilverWeight: true,
    },
  },
} satisfies Prisma.ProductionOrderSelect;

/** Khâu cấp đơn của chính mình — kèm đúng phần đơn mà thẻ phiếu cần hiển thị. */
const myOrderEntrySelect = {
  stage: true,
  handedAt: true,
  handedQty: true,
  handedSilverWeight: true,
  handedByName: true,
  submittedAt: true,
  returnedAt: true,
  returnedByName: true,
  returnedSilverWeight: true,
  stoneWeight: true,
  btpRecoveredWeight: true,
  silverRecoveredWeight: true,
  ...entryRequestsSelect,
  order: { select: myOrderCardSelect },
} satisfies Prisma.ProductionStageEntrySelect;

type MyOrderCard = Prisma.ProductionOrderGetPayload<{
  select: typeof myOrderCardSelect;
}>;
type MyOrderPending = Prisma.ProductionOrderGetPayload<{
  select: typeof myOrderPendingSelect;
}>;
type MyOrderEntry = Prisma.ProductionStageEntryGetPayload<{
  select: typeof myOrderEntrySelect;
}>;

/**
 * Phiếu con cho thợ: người lên đơn chia số lượng + gram bạc, mở khâu cho thợ tự nhận,
 * người giao xác nhận giao rồi KCS nhận lại như khâu thường (dùng chung returnStage).
 */
@Injectable()
export class ProductionSubTicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly materials: ProductionMaterialRequestsService,
  ) {}

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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_OPEN, {
        orderCode: order.code,
        stage: dto.stage,
      });
    });
  }

  async cancelOrderPending(code: string, actor: AuthUserPayload) {
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_CANCEL_OPEN, {
        orderCode: order.code,
        stage: order.pendingStage,
        before: {
          pendingByName: order.pendingByName,
          pendingAt: order.pendingAt,
          claimedByName: order.claimedByName,
        },
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_CLAIM, {
        orderCode: order.code,
        stage: order.pendingStage,
      });
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_UNCLAIM, {
        orderCode: order.code,
        stage: order.pendingStage,
        before: {
          claimedByName: order.claimedByName,
          claimedAt: order.claimedAt,
        },
      });
    });
  }

  /** Người lên đơn / admin chọn NVL xuất kho và xác nhận giao cho thợ đã tự nhận phiếu mẹ. */
  async handoverOrder(
    code: string,
    dto: HandoverInfoDto,
    actor: AuthUserPayload,
  ) {
    const touched: string[] = [];
    const detail = await this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      assertHandoverManager(order, actor);
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
      const created = await tx.productionStageEntry.create({
        data: {
          orderId: order.id,
          stage,
          attempt: entries.filter((entry) => entry.stage === stage).length + 1,
          handedByUserId: actor.id,
          handedByName: changedBy,
          handedAt,
          handedQty,
          handedSilverWeight: handedSilverOf(dto, entries),
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
      touched.push(
        ...(await this.materials.issueAtHandover(
          tx,
          order,
          created,
          dto.materials ?? [],
          actor,
        )),
      );
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_HANDOVER, {
        orderCode: order.code,
        stage,
        after: { ...entrySnapshot(created), materials: dto.materials ?? [] },
      });
    });
    for (const code of new Set(touched)) this.materials.bustStock(code);
    return detail;
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
      // Báo xong chỉ chính thợ đang giữ khâu bấm, không ai ghi hộ; gỡ nhầm thì admin gỡ được.
      const allowed =
        open.craftsmanUserId === actor.id || (!submitted && isAdmin(actor));
      if (!allowed) {
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
      await logActivity(
        tx,
        order.id,
        actor,
        submitted ? ACTIVITY.STAGE_SUBMIT : ACTIVITY.STAGE_UNSUBMIT,
        {
          orderCode: order.code,
          stage: open.stage,
          before: submitted
            ? undefined
            : {
                submittedByName: open.submittedByName,
                submittedAt: open.submittedAt,
              },
        },
      );
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
      const rows = dto.tickets;
      const totalQty = rows.reduce((sum, ticket) => sum + ticket.qty, 0);
      assertWithinTotals(order, totalQty);

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
          note: ticket.note?.trim() || null,
          createdByUserId: actor.id,
          createdByName: name,
        })),
      });
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_SPLIT, {
        orderCode: order.code,
        after: rows.map((ticket, index) => ({
          no: firstNo + index,
          qty: ticket.qty,
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
      assertWithinTotals(order, dto.qty);

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
          note: dto.note?.trim() || null,
          pendingStage: stage,
          pendingAt: stage ? new Date() : null,
          pendingByName: stage ? name : null,
          createdByUserId: actor.id,
          createdByName: name,
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_CREATE, {
        orderCode: order.code,
        subTicketNo: no,
        stage,
        after: {
          qty: dto.qty,
          note: dto.note?.trim() || null,
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
      const changed = dto.qty !== ticket.qty;
      if (changed && entriesOf(order, ticket.id).length > 0) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã giao khâu, không đổi số lượng được`,
        );
      }
      assertWithinTotals(order, dto.qty, ticket.id);
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: {
          qty: dto.qty,
          note: dto.note?.trim() || null,
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_UPDATE, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        before: {
          qty: ticket.qty,
          note: ticket.note,
        },
        after: {
          qty: dto.qty,
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
          ticket.outcome ||
          ticket.pendingStage ||
          ticket.claimedByUserId,
      );
      if (started) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, started)} đã mở hoặc bắt đầu làm, không hủy chia được`,
        );
      }
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_CLEAR_SPLIT, {
        orderCode: order.code,
        before: order.subTickets.map(ticketSnapshot),
      });
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
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_DELETE, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        before: ticketSnapshot(ticket),
      });
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
      for (const row of targets) {
        await logActivity(tx, order.id, actor, ACTIVITY.STAGE_OPEN, {
          orderCode: order.code,
          subTicketNo: row.ticket.no,
          stage: dto.stage,
        });
      }
    });
  }

  /** Huỷ khâu đang mở (kể cả khi thợ đã nhận nhưng chưa được giao). */
  async cancelPending(code: string, no: number, actor: AuthUserPayload) {
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_CANCEL_OPEN, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: ticket.pendingStage,
        before: {
          pendingByName: ticket.pendingByName,
          pendingAt: ticket.pendingAt,
          claimedByName: ticket.claimedByName,
        },
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_CLAIM, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: ticket.pendingStage,
      });
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_UNCLAIM, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: ticket.pendingStage,
        before: {
          claimedByName: ticket.claimedByName,
          claimedAt: ticket.claimedAt,
        },
      });
    });
  }

  /** Người lên đơn / admin chọn NVL xuất kho và xác nhận giao khâu cho thợ đã nhận phiếu. */
  async handover(
    code: string,
    no: number,
    dto: HandoverInfoDto,
    actor: AuthUserPayload,
  ) {
    const touched: string[] = [];
    const detail = await this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      assertHandoverManager(order, actor);
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
      const available = subTicketAvailable(ticket, entries);
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
          handedSilverWeight: handedSilverOf(dto, entries),
          ...handedStoneOf(stage, dto, order),
          craftsmanUserId: craftsman.id,
          craftsmanName,
          note: dto.note?.trim() || null,
        },
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
      touched.push(
        ...(await this.materials.issueAtHandover(
          tx,
          order,
          created,
          dto.materials ?? [],
          actor,
        )),
      );
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_HANDOVER, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage,
        after: { ...entrySnapshot(created), materials: dto.materials ?? [] },
      });
    });
    for (const code of new Set(touched)) this.materials.bustStock(code);
    return detail;
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

      const available = subTicketAvailable(ticket, entries);
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
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_OUTCOME, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: lastOf(entries)?.stage ?? null,
        after: {
          outcome,
          outcomeQty:
            outcome === SubTicketOutcome.FINISH ? available.qty : null,
        },
        note,
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
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_CLEAR_OUTCOME, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: ticket.outcomeStage,
        before: ticketSnapshot(ticket),
      });
      await this.syncOrder(tx, order, actor);
    });
  }

  /**
   * Gộp kết cục các phiếu con lên đơn mẹ. Số của phiếu hoàn thiện cộng dồn ngay vào phiếu
   * chờ nhập kho thành phẩm; SL đã được kho xác nhận giữ nguyên. Trạng thái đơn chỉ chốt
   * khi mọi phiếu con đã có kết cục —
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
          stockedQty: 0,
          receivedAt: new Date(),
          receivedByUserId: actor.id,
          receivedByName: changedBy,
        },
        update: {
          qty: finishedQty,
          stockedQty: Math.min(order.receipt?.stockedQty ?? 0, finishedQty),
        },
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
      note = `${finished.length}/${tickets.length} phiếu con hoàn thiện — ${finishedQty} sp chờ nhập kho thành phẩm`;
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
      // Dấu vết của một hành động người thật: chỉ chính thợ đang giữ khâu được bấm, kể cả
      // admin cũng không ghi hộ.
      if (open.craftsmanUserId !== actor.id) {
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_SUBMIT, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: open.stage,
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
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_UNSUBMIT, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: open.stage,
        before: {
          submittedByName: open.submittedByName,
          submittedAt: open.submittedAt,
        },
      });
      await touch(tx, order.id);
    });
  }

  async markPrinted(code: string, no: number, actor: AuthUserPayload) {
    const ticket = await this.prisma.productionSubTicket.findFirst({
      where: { no, order: { code: normalizeCode(code) } },
      select: {
        id: true,
        no: true,
        order: {
          select: { id: true, code: true, source: true, castingSentDate: true },
        },
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
    await this.prisma.productionActivityLog.create({
      data: {
        orderId: ticket.order.id,
        ...activity(actor, ACTIVITY.TICKET_PRINT, {
          orderCode: ticket.order.code,
          subTicketNo: ticket.no,
        }),
      },
    });
    return { lastPrintedAt: updated.lastPrintedAt?.toISOString() ?? null };
  }

  /** Màn "Phiếu của tôi": phiếu đang mở chờ nhận, phiếu mình đang giữ, phiếu vừa nộp. */
  async myTickets(actor: AuthUserPayload) {
    // Phiếu mẹ chạy đúng bốn nhánh như phiếu con, mỗi nhánh một câu truy vấn riêng. Gộp
    // chung một câu rồi lọc trong bộ nhớ thì `take` sẽ dùng chung: phiếu người khác đang mở
    // đủ nhiều là đẩy mất việc của chính thợ ra khỏi danh sách.
    const [
      available,
      claimed,
      working,
      recent,
      parentAvailable,
      parentClaimed,
      parentWorking,
      parentRecent,
    ] = await Promise.all([
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
        include: {
          ...entryRequestsSelect,
          subTicket: { include: myTicketInclude },
        },
        orderBy: { handedAt: 'asc' },
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          craftsmanUserId: actor.id,
          subTicketId: { not: null },
          returnedAt: { not: null },
        },
        include: {
          ...entryRequestsSelect,
          subTicket: { include: myTicketInclude },
        },
        orderBy: { returnedAt: 'desc' },
        take: RECENT_LIMIT,
      }),
      this.prisma.productionOrder.findMany({
        where: {
          subTickets: { none: {} },
          pendingStage: { not: null },
          claimedByUserId: null,
          status: { not: S.DELIVERED },
        },
        select: myOrderPendingSelect,
        orderBy: { pendingAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionOrder.findMany({
        where: {
          subTickets: { none: {} },
          claimedByUserId: actor.id,
          pendingStage: { not: null },
        },
        select: myOrderPendingSelect,
        orderBy: { claimedAt: 'asc' },
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          craftsmanUserId: actor.id,
          subTicketId: null,
          returnedAt: null,
          // Đơn đã chia thì việc đi theo phiếu con; thẻ phiếu mẹ sẽ dẫn tới ngõ cụt.
          order: { subTickets: { none: {} } },
        },
        select: myOrderEntrySelect,
        orderBy: { handedAt: 'asc' },
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          craftsmanUserId: actor.id,
          subTicketId: null,
          returnedAt: { not: null },
          order: { subTickets: { none: {} } },
        },
        select: myOrderEntrySelect,
        orderBy: { returnedAt: 'desc' },
        take: RECENT_LIMIT,
      }),
    ]);

    return {
      available: [
        ...parentAvailable.map((order) => parentPendingItem(order)),
        ...available.map((row) => pendingItem(row)),
      ],
      mine: [
        ...parentClaimed.map((order) => parentPendingItem(order)),
        ...parentWorking.map((entry) => parentEntryItem(entry)),
        ...claimed.map((row) => pendingItem(row)),
        ...working.flatMap((entry) =>
          entry.subTicket ? [entryItem(entry.subTicket, entry)] : [],
        ),
      ],
      recent: recentFirst(
        [
          ...parentRecent.map((entry) => parentEntryItem(entry)),
          ...recent.flatMap((entry) =>
            entry.subTicket ? [entryItem(entry.subTicket, entry)] : [],
          ),
        ],
        RECENT_LIMIT,
      ),
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

/** Giao khâu là lúc chọn NVL xuất kho cho thợ — chỉ người lên đơn / admin. */
function assertHandoverManager(
  order: Pick<OrderDetail, 'createdByUserId'>,
  actor: AuthUserPayload,
) {
  if (!canManage(order, actor)) {
    throw new ForbiddenException(
      'Chỉ người lên đơn hoặc admin được chọn NVL và xác nhận giao khâu',
    );
  }
}

/**
 * TL hàng chuyển từ khâu trước. Khâu đầu được để trống nếu hàng lấy từ các dòng NVL xuất
 * kho; nhưng phải có ít nhất một nguồn — không thì khâu không có mốc tính hao hụt.
 */
function handedSilverOf(
  dto: HandoverInfoDto,
  entries: readonly unknown[],
): Prisma.Decimal | null {
  const handed =
    dto.handedSilverWeight != null && dto.handedSilverWeight !== ''
      ? new Prisma.Decimal(dto.handedSilverWeight)
      : null;
  const metal = (dto.materials ?? []).some((line) => line.kind === 'METAL');
  if (handed == null && !metal) {
    throw new BadRequestException(
      entries.length
        ? 'Nhập TL hàng nhận từ khâu trước'
        : 'Khâu đầu: chọn NVL bạc xuất cho thợ hoặc nhập TL giao',
    );
  }
  return handed;
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

/** Tổng số lượng các phiếu con không vượt số lượng đơn. */
function assertWithinTotals(
  order: OrderDetail,
  qty: number,
  exceptId?: string,
) {
  const others = order.subTickets.filter((ticket) => ticket.id !== exceptId);
  const totalQty = others.reduce((sum, ticket) => sum + ticket.qty, qty);
  if (totalQty > order.qty) {
    throw new BadRequestException(
      `Tổng số lượng phiếu con (${totalQty}) vượt số lượng đơn (${order.qty})`,
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

function parentBaseItem(order: MyOrderCard) {
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

/**
 * Phần NVL của một khâu cho thẻ phiếu: bạc vào khâu (TL giao + bạc xuất), hao hụt có tính phần
 * xuất thêm, các dòng đã nhận và số yêu cầu còn chờ kho.
 */
function entryMaterials(
  entry: Parameters<typeof silverLossOf>[0] & { returnedAt: Date | null },
  requests: EntryRequests,
) {
  const issued = issuedOf(requests);
  const silverIn = silverInOf(entry, issued.metal);
  const loss = silverLossOf(entry, issued.metal);
  return {
    silverWeight: silverIn != null ? decStr(silverIn) : null,
    silverLoss: loss != null ? decStr(loss) : null,
    silverLossPercent: (() => {
      const percent = lossPercentOf(loss, silverIn);
      return percent != null ? decStr(percent) : null;
    })(),
    issuedLines: requests
      .filter((request) => request.status === MaterialRequestStatus.ISSUED)
      .map((request) => ({
        atHandover: request.atHandover,
        sku: request.material.sku,
        name: request.material.name,
        unit: request.material.unit.name,
        qty: request.issuedQty != null ? decStr(request.issuedQty) : null,
        weight:
          request.issuedWeight != null ? decStr(request.issuedWeight) : null,
      })),
    pendingRequests: requests.filter(
      (request) => request.status === MaterialRequestStatus.PENDING,
    ).length,
  };
}

const NO_MATERIALS = {
  silverLossPercent: null,
  issuedLines: [],
  pendingRequests: 0,
};

function parentPendingItem(order: MyOrderPending) {
  // `stages` đã lọc sẵn khâu cấp đơn ngay trong câu truy vấn.
  const entries = order.stages;
  const { state } = orderTicketState(order, entries);
  const available = orderTicketAvailable(order, entries);
  return {
    ...parentBaseItem(order),
    state,
    stage: order.pendingStage,
    qty: available.qty,
    silverWeight: available.silver != null ? decStr(available.silver) : null,
    pendingAt: order.pendingAt?.toISOString() ?? null,
    claimedAt: order.claimedAt?.toISOString() ?? null,
    submittedAt: null,
    handedAt: null,
    handedByName: null,
    returnedAt: null,
    returnedByName: null,
    returnedSilverWeight: null,
    silverLoss: null,
    ...NO_MATERIALS,
  };
}

function parentEntryItem(entry: MyOrderEntry) {
  const { order } = entry;
  const materials = entryMaterials(entry, entry.materialRequests);
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
    ...materials,
  };
}

function pendingItem(row: MyTicketRow) {
  const { state } = subTicketState(row, row.stages);
  const available = subTicketAvailable(row, row.stages);
  return {
    ...baseItem(row),
    state,
    stage: row.pendingStage,
    qty: available.qty,
    silverWeight: available.silver != null ? decStr(available.silver) : null,
    pendingAt: row.pendingAt?.toISOString() ?? null,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    submittedAt: null,
    handedAt: null,
    handedByName: null,
    returnedAt: null,
    returnedByName: null,
    returnedSilverWeight: null,
    silverLoss: null,
    ...NO_MATERIALS,
  };
}

function entryItem(
  row: MyTicketRow,
  entry: StageEntry & { materialRequests: EntryRequests },
) {
  const materials = entryMaterials(entry, entry.materialRequests);
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
    ...materials,
  };
}
