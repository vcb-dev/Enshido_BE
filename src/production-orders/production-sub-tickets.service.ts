import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CastingSlipStatus,
  MaterialRequestStatus,
  Prisma,
  ProductionSource,
  ProductionStage,
  ProductionStatus,
  RoleCode,
  SubTicketOutcome,
} from '@prisma/client';
import { Permission, userCan, userHasRole } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { dbTable } from '../prisma/database-url';
import { InventoryService } from '../inventory/inventory.service';
import {
  intakeCode,
  nextIntakeSeq,
  nextOrderSeq,
  orderCode,
  randomSxCode,
} from './intake-order';
import { PrismaService } from '../prisma/prisma.service';
import { decStr } from '../util/money';
import {
  AssignSubTicketDto,
  EarlyStoneReturnDto,
  HandoverInfoDto,
  StoneHoldLineDto,
  OpenOrderStageDto,
  SplitSubTicketsDto,
  StageDefectDto,
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
  furthestStatus,
  deriveOrderStatus,
  ticketStatus,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_STATUS,
  type StageEntry,
  type SubTicket,
  subTicketAvailable,
  subTicketCode,
  subTicketState,
  toDetail,
  assertHandedSilverWithin,
  blankLeftOf,
  ticketNetQty,
  KEEPER_CONFIRM_STAGES,
  requireStage,
  DEFECT_STATUSES,
  defectStatusOf,
  skipsStone,
  STATUS_LABEL,
} from './order-detail';
import {
  ACTIVITY,
  activity,
  entrySnapshot,
  logActivity,
  ticketSnapshot,
} from './activity-log';
import {
  ProductionMaterialRequestsService,
  todayVn,
} from './production-material-requests.service';
import {
  issuedOf,
  lossPercentOf,
  silverInOf,
  silverLossOf,
  stoneUsedByHold,
  stoneUsedQty,
} from './stage-math';
import {
  assertStoneFree,
  isCountUnit,
  packWeightOf,
  planEarlyReturn,
} from './stone-holds';

const S = ProductionStatus;

const BTP_WAREHOUSE = 'btp-cho-vao-da';
const NVL_WAREHOUSE = 'nvl-chinh';
/** Cùng mã với phần còn lại của cây sau đúc (casting-slips) để tồn bạc thu hồi gom một chỗ. */
const REST_S925_NAME = 'Bạc thu hồi / đầu cây S925';
const REST_S999_NAME = 'Bạc S999 thu hồi';

const RECENT_LIMIT = 20;
const AVAILABLE_LIMIT = 100;
/** Admin xem Phiếu của tôi: giới hạn mỗi nhánh để tránh kéo cả kho dữ liệu. */
const MINE_LIMIT = 100;

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
      _count: { select: { subTickets: true } },
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
  stages: {
    orderBy: { createdAt: 'asc' },
    select: {
      stage: true,
      returnedAt: true,
      submittedAt: true,
      handedQty: true,
      handedSilverWeight: true,
      returnedQty: true,
      returnedSilverWeight: true,
    },
  },
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
  scrapS999Weight: true,
  ...entryRequestsSelect,
  order: { select: myOrderCardSelect },
} satisfies Prisma.ProductionStageEntrySelect;

/** Phần riêng màn Phiếu QC cần thêm của một lần giao khâu: id để cân, thợ, báo lỗi, lượt sửa. */
const qcEntrySelect = {
  id: true,
  attempt: true,
  craftsmanName: true,
  defectReportedAt: true,
  defectReportedByName: true,
  defectNote: true,
  returnedQty: true,
  defectQty: true,
  kcsRevisionCount: true,
  confirmedAt: true,
} satisfies Prisma.ProductionStageEntrySelect;

function qcExtras(
  entry: Prisma.ProductionStageEntryGetPayload<{
    select: typeof qcEntrySelect;
  }>,
) {
  return {
    entryId: entry.id,
    attempt: entry.attempt,
    craftsmanName: entry.craftsmanName,
    defectReportedAt: entry.defectReportedAt?.toISOString() ?? null,
    defectReportedByName: entry.defectReportedByName,
    defectNote: entry.defectNote,
    returnedQty: entry.returnedQty,
    defectQty: entry.defectQty,
    kcsRevisionCount: entry.kcsRevisionCount,
    confirmedAt: entry.confirmedAt?.toISOString() ?? null,
  };
}

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
 * người giao xác nhận giao rồi QC nhận lại như khâu thường (dùng chung returnStage).
 */
@Injectable()
export class ProductionSubTicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly materials: ProductionMaterialRequestsService,
    private readonly inventory: InventoryService,
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
        'Cắt cây thông (cân phôi) cho đơn trước khi mở khâu cho thợ',
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
      await assertCanTakeStage(tx, actor, order.pendingStage);
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
          'Chỉ thợ đã nhận, người lên đơn, thủ kho hoặc admin được gỡ lượt nhận',
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
        'Cắt cây thông (cân phôi) cho đơn trước khi giao khâu cho thợ',
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
          'Thời gian giao không được trước lúc QC nhận lại khâu trước',
        );
      }
      const craftsmanName = actorName(craftsman);
      const changedBy = actorName(actor);
      const nextStatus = STAGE_STATUS[stage];
      const handedSilver = handedSilverOf(dto, entries);
      // TL giao không vượt hàng đang có (QC nhận lại khâu trước / phôi sau đúc).
      assertHandedSilverWithin(order, null, handedSilver);
      const created = await tx.productionStageEntry.create({
        data: {
          orderId: order.id,
          stage,
          attempt: entries.filter((entry) => entry.stage === stage).length + 1,
          handedByUserId: actor.id,
          handedByName: changedBy,
          handedAt,
          handedQty,
          handedSilverWeight: handedSilver,
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
        'Cắt cây thông (cân phôi) cho đơn trước khi chia phiếu con',
      );
      // Đơn từ đúc có sẵn một phiếu -1 (mặc định 1 đơn là 1 phiếu): chia lại khi phiếu đó
      // còn nguyên, chưa mở khâu / chưa giao thợ.
      const defaultTicket =
        order.subTickets.length === 1 ? order.subTickets[0] : null;
      if (defaultTicket && !isUntouched(order, defaultTicket)) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, defaultTicket)} đã mở khâu / giao thợ — cả đơn đi tiếp trên phiếu này, không chia lại được`,
        );
      }
      if (order.subTickets.length > 1) {
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
          `Khâu ${STAGE_LABEL[open.stage]} của cả đơn chưa được QC nhận lại, chưa chia phiếu con được`,
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
      const allRows = dto.tickets;
      const totalQty = allRows.reduce((sum, ticket) => sum + ticket.qty, 0);
      if (totalQty > order.qty) {
        throw new BadRequestException(
          `Tổng số lượng phiếu con (${totalQty}) vượt số lượng đơn (${order.qty})`,
        );
      }
      // Phiếu -1 giữ nguyên số, chỉ đổi số lượng; các phiếu còn lại đánh số tiếp.
      const rows = defaultTicket ? allRows.slice(1) : allRows;
      if (defaultTicket) {
        await tx.productionSubTicket.update({
          where: { id: defaultTicket.id },
          data: { qty: allRows[0].qty, note: allRows[0].note?.trim() || null },
        });
      }

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
        after: allRows.map((ticket, index) => ({
          no: defaultTicket
            ? index === 0
              ? defaultTicket.no
              : firstNo + index - 1
            : firstNo + index,
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
        'Cắt cây thông (cân phôi) cho đơn trước khi chia phiếu con',
      );
      if (order.subTickets.length === 0) {
        throw new BadRequestException(
          'Lần chia đầu tiên phải tạo ít nhất 2 phiếu con',
        );
      }
      const open = openOrderEntry(order);
      if (open) {
        throw new BadRequestException(
          `Khâu ${STAGE_LABEL[open.stage]} của cả đơn chưa được QC nhận lại, chưa chia phiếu con được`,
        );
      }
      assertWithinTotals(order, dto.qty);

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
          createdByUserId: actor.id,
          createdByName: name,
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_CREATE, {
        orderCode: order.code,
        subTicketNo: no,
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
      // Số phiếu chỉ đánh lại từ đầu khi chưa phiếu nào bị xoá từng được in — phiếu giấy đã in
      // mang mã cũ, dùng lại số thì QR đó sẽ trỏ sang phiếu khác.
      const printed = order.subTickets.some((ticket) => ticket.lastPrintedAt);
      await tx.productionSubTicket.deleteMany({
        where: { orderId: order.id },
      });
      if (!printed) {
        await tx.productionOrder.update({
          where: { id: order.id },
          data: { subTicketSeq: 0 },
        });
      }
      await touch(tx, order.id);
    });
  }

  async remove(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertManager(order, actor);
      const ticket = requireSubTicket(order, no);
      if (order.subTickets.length === 1) {
        throw new BadRequestException('Đơn phải còn ít nhất một phiếu');
      }
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
      // Phiếu đã chỉ định thợ kèm đá: huỷ phiếu xuất nháp trước khi xoá, kẻo treo giữ chỗ.
      await this.releasePendingHolds(tx, ticket.id, actorName(actor));
      await tx.productionSubTicket.delete({ where: { id: ticket.id } });
      await touch(tx, order.id);
    }).then((detail) => {
      this.inventory.bustNvlStock();
      return detail;
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
      // Đá đang giữ chỗ cho khâu vừa huỷ thì nhả ra (huỷ phiếu xuất nháp), cấp lại khi chỉ định lại.
      await this.releasePendingHolds(tx, ticket.id, actorName(actor));
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
    }).then((detail) => {
      // Nhả giữ chỗ đá thì số khả dụng ở màn kho đổi theo.
      this.inventory.bustNvlStock();
      return detail;
    });
  }

  /**
   * Bước 11: thủ kho chỉ định thợ cho khâu kế tiếp của phiếu con. Chưa giao hàng — thợ phải
   * quét QR và bấm nhận (`accept`) thì hệ thống mới ghi giao khâu và xuất kho.
   */
  async assign(
    code: string,
    no: number,
    dto: AssignSubTicketDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertManager(order, actor);
      assertOrderActive(order);
      assertCastingReady(
        order,
        'Cắt cây thông (cân phôi) cho đơn trước khi giao thợ',
      );
      const ticket = requireSubTicket(order, no);
      const entries = entriesOf(order, ticket.id);
      const { state } = subTicketState(ticket, entries);
      if (state !== 'IDLE') {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đang ${STATE_LABEL[state]}, chưa chỉ định thợ được`,
        );
      }
      const last = lastOf(entries) ?? lastOf(orderEntries(order));
      let stage = dto.stage ?? nextStageAfter(last?.stage ?? null);
      // Đơn không có đá (0 viên theo 3D) bỏ qua khâu Vào đá khi để hệ thống chọn khâu kế tiếp.
      if (
        !dto.stage &&
        stage === ProductionStage.STONE_SETTING &&
        skipsStone(order)
      ) {
        stage = nextStageAfter(stage);
      }
      if (!stage) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã qua khâu cuối — chốt Hoàn thiện / Lỗi thay vì giao thợ`,
        );
      }
      const reworking = !IN_STAGE_STATUSES.includes(order.status);
      if (
        last &&
        !reworking &&
        STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(last.stage)
      ) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} đã qua khâu ${STAGE_LABEL[last.stage]} — khâu mới phải sau khâu đó`,
        );
      }
      const craftsman = await tx.user.findFirst({
        where: { id: dto.craftsmanUserId, isActive: true },
        select: {
          id: true,
          fullName: true,
          username: true,
          roleCode: true,
          extraRoles: true,
          workerStages: true,
        },
      });
      if (!craftsman) {
        throw new BadRequestException('Tài khoản thợ không còn hoạt động');
      }
      if (
        !userHasRole(
          craftsman.roleCode,
          craftsman.extraRoles,
          RoleCode.ADMIN,
        ) &&
        !craftsman.workerStages.includes(stage)
      ) {
        throw new BadRequestException(
          `${actorName(craftsman)} chưa được giao khâu ${STAGE_LABEL[stage]} — thêm khâu ở màn Nhân sự`,
        );
      }
      const stones = dto.stones ?? [];
      if (
        stage === ProductionStage.STONE_SETTING &&
        stones.length === 0 &&
        !skipsStone(order)
      ) {
        throw new BadRequestException(
          'Khâu Vào đá: chọn đá cấp cho thợ (số viên, TL)',
        );
      }
      if (stage !== ProductionStage.STONE_SETTING && stones.length > 0) {
        throw new BadRequestException('Chỉ khâu Vào đá mới cấp đá');
      }
      const now = new Date();
      await this.holdStones(tx, order, ticket.id, stones, actorName(actor));
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: {
          pendingStage: stage,
          pendingAt: now,
          pendingByName: actorName(actor),
          claimedByUserId: craftsman.id,
          claimedByName: actorName(craftsman),
          claimedAt: now,
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_OPEN, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage,
        after: { craftsmanName: actorName(craftsman) },
      });
    }).then((detail) => {
      // Giữ chỗ đá mới thì số khả dụng ở màn kho đổi theo.
      if (dto.stones?.length) this.inventory.bustNvlStock();
      return detail;
    });
  }

  /**
   * Giữ chỗ đá cho phiếu con: kiểm tra tồn trừ phần đã giữ cho phiếu khác, rồi ghi hold. Chưa
   * xuất kho — hệ thống chỉ xuất khi thủ kho xác nhận sau QC, theo tỷ lệ TL gói thừa QC cân.
   */
  private async holdStones(
    tx: Prisma.TransactionClient,
    order: OrderDetail,
    ticketId: string,
    lines: readonly StoneHoldLineDto[],
    by: string,
  ) {
    // Chỉ định lại sau khi huỷ / gỡ: bỏ các hold cũ chưa gắn khâu của phiếu này.
    await this.releasePendingHolds(tx, ticketId, by);
    const ticket = order.subTickets.find((item) => item.id === ticketId);
    const label = ticket ? ticketCode(order, ticket) : order.code;
    for (const line of lines) {
      const material = await tx.material.findFirst({
        where: {
          id: line.materialId,
          isActive: true,
          warehouse: { code: NVL_WAREHOUSE },
        },
        select: {
          id: true,
          name: true,
          sku: true,
          warehouseId: true,
          unit: { select: { id: true, name: true } },
        },
      });
      if (!material) {
        throw new BadRequestException('Mã đá phải thuộc kho NVL chính');
      }
      const weight = packWeightOf(line.weight);
      const qty = stoneQtyOf(material, line.stoneCount, weight);
      await assertStoneFree(tx, this.inventory, material, qty);
      // Phía kho: phiếu xuất nháp (chưa trừ tồn, trừ khả dụng). Phía sản xuất: chi tiết cấp đá.
      const draft = await this.inventory.createOutboundDraft(tx, {
        material,
        qty,
        gramQty: weight,
        productionOrderId: order.id,
        note: `Đá phiếu ${label} · khâu Vào đá — cấp lúc chỉ định thợ`,
        createdByName: by,
      });
      await tx.productionStoneHold.create({
        data: {
          orderId: order.id,
          subTicketId: ticketId,
          materialId: material.id,
          draftId: draft.id,
          qty,
          stoneCount: line.stoneCount ?? null,
          weight,
          createdByName: by,
        },
      });
    }
  }

  /** Nhả đá giữ chỗ của khâu chưa giao (huỷ / chỉ định lại): dòng giữ chỗ + phiếu xuất nháp. */
  private async releasePendingHolds(
    tx: Prisma.TransactionClient,
    ticketId: string,
    by: string,
  ) {
    const holds = await tx.productionStoneHold.findMany({
      where: { subTicketId: ticketId, status: 'HELD', stageEntryId: null },
      select: { id: true, draftId: true },
    });
    if (holds.length === 0) return;
    await tx.productionStoneHold.updateMany({
      where: { id: { in: holds.map((hold) => hold.id) } },
      data: { status: 'RELEASED' },
    });
    await this.inventory.closeOutboundDraft(
      tx,
      holds.flatMap((hold) => (hold.draftId ? [hold.draftId] : [])),
      by,
    );
  }

  /**
   * Thợ được chỉ định quét QR, bấm nhận hàng; hệ thống ghi giao khâu và tự xuất BTP khỏi kho:
   * - Nguội: phôi của phiếu (SL = SL phiếu, TL chia theo phôi còn lại của đơn).
   * - Vào đá: BTP đã nguội thủ kho nhập kho ở bước xác nhận (SL + TL QC nhận lại); đá cấp ở
   *   bước chỉ định được gắn vào khâu nhưng CHƯA xuất kho — xuất khi xác nhận sau QC.
   * Khâu khác chưa đi qua kho nên người giao cân bạc và bấm "Xác nhận giao".
   */
  async accept(code: string, no: number, actor: AuthUserPayload) {
    const touched: string[] = [];
    const detail = await this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      const ticket = requireSubTicket(order, no);
      const entries = entriesOf(order, ticket.id);
      const { state } = subTicketState(ticket, entries);
      const stage = ticket.pendingStage;
      if (state !== 'CLAIMED' || !stage || !ticket.claimedByUserId) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa được chỉ định thợ để nhận`,
        );
      }
      // Chỉ chính thợ được chỉ định nhận hàng — không ai nhận thay, kể cả admin.
      if (ticket.claimedByUserId !== actor.id) {
        throw new ForbiddenException(
          `Phiếu ${ticketCode(order, ticket)} giao cho ${ticket.claimedByName ?? 'thợ khác'} — chỉ thợ đó nhận hàng`,
        );
      }
      if (
        stage !== ProductionStage.FILING &&
        stage !== ProductionStage.STONE_SETTING
      ) {
        throw new BadRequestException(
          `Khâu ${STAGE_LABEL[stage]} không nhận hàng qua QR — nhờ người giao bấm "Xác nhận giao"`,
        );
      }
      const craftsman = await tx.user.findFirst({
        where: { id: ticket.claimedByUserId, isActive: true },
        select: { id: true, fullName: true, username: true },
      });
      if (!craftsman) {
        throw new BadRequestException(
          'Tài khoản thợ được chỉ định không còn hoạt động',
        );
      }

      // Hàng giao cho thợ: số lượng, TL (gram) và dòng xuất BTP tự động.
      let handedQty = ticket.qty;
      let handedSilverWeight: Prisma.Decimal | null = null;
      let line: { materialId: string; weight: Prisma.Decimal } | null = null;
      let holds: Array<{
        id: string;
        stoneCount: number | null;
        weight: Prisma.Decimal | null;
      }> = [];
      if (stage === ProductionStage.FILING) {
        // Phôi của phiếu: SL = SL phiếu; TL chia theo phôi còn lại (phiếu cuối lấy hết).
        const left = blankLeftOf(order);
        if (
          !left.btpMaterialId ||
          left.leftQty == null ||
          left.leftWeight == null
        ) {
          throw new BadRequestException(
            `Đơn ${order.code} chưa có phôi sau đúc trong kho BTP`,
          );
        }
        const leftQty = new Prisma.Decimal(left.leftQty);
        const leftWeight = new Prisma.Decimal(left.leftWeight);
        if (leftQty.lt(ticket.qty)) {
          throw new BadRequestException(
            `Phôi của đơn ${order.code} chỉ còn ${decStr(leftQty)} chiếc, phiếu cần ${ticket.qty}`,
          );
        }
        line = {
          materialId: left.btpMaterialId,
          weight: leftQty.eq(ticket.qty)
            ? leftWeight
            : leftWeight.mul(ticket.qty).div(leftQty).toDecimalPlaces(4),
        };
      } else {
        const previous = lastOf(entries);
        if (!previous?.returnedAt || previous.confirmedAt === null) {
          throw new BadRequestException(
            `Phiếu ${ticketCode(order, ticket)} chưa được QC nhận và thủ kho xác nhận khâu trước`,
          );
        }
        const available = subTicketAvailable(ticket, entries);
        handedQty = available.qty;
        const weight = previous.returnedSilverWeight;
        if (!weight || weight.lte(0)) {
          throw new BadRequestException('Khâu trước chưa có TL hàng nhận lại');
        }
        if (previous.outputMaterialId) {
          line = { materialId: previous.outputMaterialId, weight };
        } else {
          // Khâu trước làm theo luồng cũ (không nhập kho BTP): chỉ chuyển hàng, không xuất kho.
          handedSilverWeight = weight;
        }
        holds = await tx.productionStoneHold.findMany({
          where: { subTicketId: ticket.id, status: 'HELD', stageEntryId: null },
          select: { id: true, stoneCount: true, weight: true },
        });
        if (holds.length === 0 && !skipsStone(order)) {
          throw new BadRequestException(
            `Phiếu ${ticketCode(order, ticket)} chưa được cấp đá — nhờ thủ kho chỉ định lại kèm đá`,
          );
        }
      }

      const handedAt = new Date();
      const handedByName = ticket.pendingByName ?? 'Thủ kho';
      // Đá tính theo ct / g có thể không đếm viên: chỉ cộng các dòng có số viên.
      const stoneCount = holds.some((hold) => hold.stoneCount != null)
        ? holds.reduce((sum, hold) => sum + (hold.stoneCount ?? 0), 0)
        : null;
      const stoneWeight = holds.every((hold) => hold.weight != null)
        ? holds.reduce(
            (sum, hold) => sum.add(hold.weight ?? 0),
            new Prisma.Decimal(0),
          )
        : null;
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
          handedByName,
          handedAt,
          handedQty,
          handedSilverWeight,
          ...(holds.length > 0
            ? {
                handedStoneCount: stoneCount,
                handedStoneWeight: holds.length > 0 ? stoneWeight : null,
              }
            : {}),
          craftsmanUserId: craftsman.id,
          craftsmanName: actorName(craftsman),
        },
      });
      if (holds.length > 0) {
        await tx.productionStoneHold.updateMany({
          where: { id: { in: holds.map((hold) => hold.id) } },
          data: { stageEntryId: created.id },
        });
      }
      const nextStatus = deriveOrderStatus({
        status: S.FILING,
        stoneCount: order.stoneCount,
        stoneSkipped: order.stoneSkipped,
        pendingStage: null,
        claimedByUserId: null,
        subTickets: order.subTickets.map((other) =>
          other.id === ticket.id ? { ...other, ...CLEAR_PENDING } : other,
        ),
        stages: [...order.stages, created],
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
                    note: `${actorName(craftsman)} nhận ${STAGE_LABEL[stage]} (phiếu ${ticketCode(order, ticket)})`,
                    changedBy: actorName(craftsman),
                  },
                },
        },
      });
      if (line) {
        touched.push(
          ...(await this.materials.issueAtHandover(
            tx,
            order,
            created,
            [
              {
                materialId: line.materialId,
                kind: 'METAL',
                qty: String(handedQty),
                weight: decStr(line.weight),
              },
            ],
            actor,
          )),
        );
      }
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_HANDOVER, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage,
        after: {
          ...entrySnapshot(created),
          acceptedBy: actorName(craftsman),
          heldStoneCount: holds.length > 0 ? stoneCount : null,
        },
      });
    });
    for (const code of new Set(touched)) this.materials.bustStock(code);
    return detail;
  }

  /**
   * Báo lỗi ngay ở khâu đang làm của phiếu con: thợ đang giữ khâu, QC hoặc admin. Khâu coi như
   * đã nộp để QC cân lại — không ghi đè lên "thợ báo xong". Nguội / Vào đá đạt 0 thì sau khi
   * thủ kho xác nhận phiếu tự chốt Lỗi tại khâu đó; các khâu khác QC chốt Lỗi sau khi nhận lại.
   */
  async reportStageDefect(
    code: string,
    no: number,
    dto: StageDefectDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      const ticket = requireSubTicket(order, no);
      const entries = entriesOf(order, ticket.id);
      const open = entries.find((entry) => !entry.returnedAt);
      if (!open) {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} không có khâu nào đang làm để báo lỗi`,
        );
      }
      const isHolder = open.craftsmanUserId === actor.id;
      if (
        !isHolder &&
        !isAdmin(actor) &&
        !userCan(actor, Permission.PRODUCTION_QC)
      ) {
        throw new ForbiddenException(
          'Chỉ thợ đang giữ khâu, QC hoặc admin được báo lỗi khâu này',
        );
      }
      if (open.defectReportedAt) {
        throw new BadRequestException('Khâu này đã được báo lỗi');
      }
      await tx.productionStageEntry.update({
        where: { id: open.id },
        data: {
          defectReportedAt: new Date(),
          defectReportedByUserId: actor.id,
          defectReportedByName: actorName(actor),
          defectNote: dto.note,
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_DEFECT, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: open.stage,
        note: dto.note,
      });
      await touch(tx, order.id);
    });
  }

  /** Bỏ báo lỗi (báo nhầm): người đã báo, QC hoặc admin — chỉ khi QC chưa nhận lại. */
  async clearStageDefect(code: string, no: number, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      const ticket = requireSubTicket(order, no);
      const open = entriesOf(order, ticket.id).find(
        (entry) => !entry.returnedAt,
      );
      if (!open?.defectReportedAt) {
        throw new BadRequestException('Khâu này chưa báo lỗi');
      }
      if (
        open.defectReportedByUserId !== actor.id &&
        !isAdmin(actor) &&
        !userCan(actor, Permission.PRODUCTION_QC)
      ) {
        throw new ForbiddenException(
          'Chỉ người đã báo lỗi, QC hoặc admin được bỏ báo lỗi',
        );
      }
      await tx.productionStageEntry.update({
        where: { id: open.id },
        data: {
          defectReportedAt: null,
          defectReportedByUserId: null,
          defectReportedByName: null,
          defectNote: null,
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_CLEAR_DEFECT, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: open.stage,
      });
      await touch(tx, order.id);
    });
  }

  /**
   * Bước 13–15, 18: thủ kho xác nhận sau khi QC nhận lại khâu Nguội / Vào đá. Lúc này mới nhập
   * kho: hàng đạt → kho BTP (mã riêng của đơn, khâu sau lấy hàng từ đây), hàng lỗi + nguyên liệu
   * thừa S925 / S999 → kho NVL. Cả phiếu lỗi 100% thì phiếu tự chốt Lỗi (M Lỗi nguội…).
   *
   * Thủ kho chỉ kiểm tra khi QC báo có hàng lỗi. QC cân không có hàng lỗi thì `auto`: hệ thống tự
   * xác nhận ngay sau khi QC lưu (người xác nhận ghi là QC) — các bước nhập kho y như thủ kho bấm.
   */
  async confirmStage(
    code: string,
    stageId: string,
    actor: AuthUserPayload,
    auto = false,
  ) {
    return this.mutate(code, async (tx, order) => {
      const entry = requireStage(order, stageId);
      if (auto && (entry.defectQty ?? 0) > 0) {
        throw new BadRequestException(
          'Có hàng lỗi — chờ thủ kho kiểm tra và xác nhận lỗi',
        );
      }
      const ticket = order.subTickets.find(
        (item) => item.id === entry.subTicketId,
      );
      if (!ticket || !KEEPER_CONFIRM_STAGES.includes(entry.stage)) {
        throw new BadRequestException(
          `Khâu ${STAGE_LABEL[entry.stage]} không có bước thủ kho xác nhận`,
        );
      }
      if (!entry.returnedAt) {
        throw new BadRequestException('QC chưa nhận lại khâu này');
      }
      if (entry.confirmedAt) {
        throw new BadRequestException('Thủ kho đã xác nhận khâu này');
      }
      const label = ticketCode(order, ticket);
      const stageName = STAGE_LABEL[entry.stage];
      const by = actorName(actor);
      const now = new Date();
      const inboundIds: string[] = [];
      let outputMaterialId: string | null = null;

      const goodQty = entry.returnedQty ?? 0;
      const goodWeight = entry.returnedSilverWeight;
      if (goodQty > 0 && goodWeight && goodWeight.gt(0)) {
        outputMaterialId = await this.inventory.ensureNamedMaterial(tx, {
          warehouseCode: BTP_WAREHOUSE,
          name: `BTP đã ${stageName.toLowerCase()} ${order.code}`,
          unitCode: 'chiec',
        });
        inboundIds.push(
          await this.inventory.createAutoInbound(tx, {
            materialId: outputMaterialId,
            qty: new Prisma.Decimal(goodQty),
            gramQty: goodWeight,
            receivedAt: now,
            note: `Hàng đạt khâu ${stageName} phiếu ${label}`,
            enteredBy: by,
            productionOrderId: order.id,
          }),
        );
      }
      // Hàng lỗi cân gram + S925 thừa nhập chung một mã NVL bạc; S999 thừa mã riêng.
      const s925 = (entry.btpRecoveredWeight ?? new Prisma.Decimal(0)).add(
        entry.silverRecoveredWeight ?? 0,
      );
      if (s925.gt(0)) {
        const materialId = await this.inventory.ensureNamedMaterial(tx, {
          warehouseCode: NVL_WAREHOUSE,
          name: REST_S925_NAME,
          unitCode: 'gram',
        });
        inboundIds.push(
          await this.inventory.createAutoInbound(tx, {
            materialId,
            qty: s925,
            gramQty: s925,
            receivedAt: now,
            note: `Hàng lỗi + nguyên liệu S925 thừa khâu ${stageName} phiếu ${label}`,
            enteredBy: by,
            productionOrderId: order.id,
          }),
        );
      }
      if (entry.scrapS999Weight?.gt(0)) {
        const materialId = await this.inventory.ensureNamedMaterial(tx, {
          warehouseCode: NVL_WAREHOUSE,
          name: REST_S999_NAME,
          unitCode: 'gram',
        });
        inboundIds.push(
          await this.inventory.createAutoInbound(tx, {
            materialId,
            qty: entry.scrapS999Weight,
            gramQty: entry.scrapS999Weight,
            receivedAt: now,
            note: `Nguyên liệu S999 thừa khâu ${stageName} phiếu ${label}`,
            enteredBy: by,
            productionOrderId: order.id,
          }),
        );
      }
      if (entry.stage === ProductionStage.STONE_SETTING) {
        await this.consumeStoneHolds(tx, order, entry, by);
      }
      await tx.productionStageEntry.update({
        where: { id: entry.id },
        data: {
          confirmedAt: now,
          confirmedByUserId: actor.id,
          confirmedByName: by,
          outputMaterialId,
          stockInboundIds: inboundIds,
        },
      });

      const allDefect = goodQty === 0;
      if (allDefect) {
        // 100% hàng lỗi: phiếu chốt Lỗi ngay, hàng đã về kho NVL; phiếu bù ở bước sau.
        await tx.productionSubTicket.update({
          where: { id: ticket.id },
          data: {
            ...CLEAR_PENDING,
            outcome: SubTicketOutcome.DEFECT,
            outcomeAt: now,
            outcomeByUserId: actor.id,
            outcomeByName: by,
            outcomeStage: entry.stage,
            outcomeQty: null,
            outcomeNote: defectNoteOf(entry, stageName),
          },
        });
      }
      await logActivity(tx, order.id, actor, ACTIVITY.STAGE_CONFIRM, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: entry.stage,
        after: {
          goodQty,
          goodWeight,
          defectQty: entry.defectQty,
          stockInboundCount: inboundIds.length,
        },
        note: auto
          ? 'Tự xác nhận — QC không báo hàng lỗi, không cần thủ kho kiểm tra'
          : undefined,
      });
      await this.syncOrderAfterStage(tx, order.id, actor, allDefect);
    }).then((detail) => {
      this.inventory.bustBtpStock();
      this.inventory.bustNvlStock();
      return detail;
    });
  }

  /**
   * Xuất kho đá lúc thủ kho xác nhận Vào đá — cả đá cấp lúc chỉ định lẫn đá thợ xin thêm. Mỗi
   * dòng: SL xuất = SL cấp × (TL gói cấp − TL gói thừa QC cân) / TL gói cấp; phần thừa vẫn nằm
   * trong kho (chưa từng bị trừ). Dòng cũ không cân gói thì theo số viên thừa QC đếm.
   */
  private async consumeStoneHolds(
    tx: Prisma.TransactionClient,
    order: OrderDetail,
    entry: StageEntry,
    by: string,
  ) {
    const holds = await tx.productionStoneHold.findMany({
      where: { stageEntryId: entry.id, status: 'HELD' },
      orderBy: { createdAt: 'asc' },
    });
    // QC nhận lại trước khi có cân gói thừa: chia số viên trả tổng như trước.
    const legacy = holds.every(
      (hold) => hold.returnedWeight == null && hold.returnedCount == null,
    );
    const legacyUsed = legacy
      ? stoneUsedByHold(
          holds.map((hold) => ({
            id: hold.id,
            stoneCount: hold.stoneCount ?? 0,
          })),
          entry.returnedStoneCount ?? 0,
        )
      : null;
    for (const hold of holds) {
      const count = hold.stoneCount ?? 0;
      const returnedCount = legacyUsed
        ? count - (legacyUsed.get(hold.id) ?? count)
        : (hold.returnedCount ?? 0);
      // Đá tính theo ct / g không đếm viên thì không có số viên đã dùng.
      const used =
        hold.stoneCount != null ? Math.max(0, count - returnedCount) : null;
      const material = await tx.material.findUniqueOrThrow({
        where: { id: hold.materialId },
        select: {
          id: true,
          name: true,
          sku: true,
          warehouseId: true,
          unit: { select: { id: true, name: true } },
        },
      });
      const qty = stoneUsedQty(
        {
          ...hold,
          returnedWeight: legacy ? null : hold.returnedWeight,
          returnedCount,
        },
        isCountUnit(material.unit.name),
      );
      if (qty.lte(0)) {
        await tx.productionStoneHold.update({
          where: { id: hold.id },
          data: { status: 'RELEASED', usedCount: 0 },
        });
        // Thừa hết: phiếu xuất nháp huỷ, không xuất gì.
        if (hold.draftId) {
          await this.inventory.closeOutboundDraft(tx, [hold.draftId], by);
        }
        continue;
      }
      const packNote =
        hold.weight != null && hold.returnedWeight != null
          ? `cấp ${decStr(hold.weight)} g, thừa ${decStr(hold.returnedWeight)} g`
          : `cấp ${count} viên, trả ${returnedCount} viên`;
      const outbound = await this.inventory.issueStockForOrder(tx, {
        orderId: order.id,
        orderCode: order.code,
        material,
        qty,
        // TL xuất = TL gói đang giữ − TL gói thừa QC cân (phần trả giữa khâu đã trừ khỏi gói).
        gramQty:
          hold.weight != null && hold.returnedWeight != null
            ? Prisma.Decimal.max(hold.weight.sub(hold.returnedWeight), 0)
            : null,
        issuedAt: todayVn(),
        issuedBy: by,
        note: `Đá khâu Vào đá${hold.requestId ? ' (thợ xin thêm)' : ''} — ${packNote}`,
      });
      await tx.productionStoneHold.update({
        where: { id: hold.id },
        data: {
          status: 'CONSUMED',
          usedCount: used,
          outboundId: outbound?.id ?? null,
        },
      });
      // Phiếu xuất nháp thành phiếu xuất thật (SL / TL đã dùng).
      if (hold.draftId && outbound) {
        await this.inventory.closeOutboundDraft(
          tx,
          [hold.draftId],
          by,
          outbound.id,
        );
      }
      // Gắn phiếu xuất vào yêu cầu xin thêm — sửa đơn không hoàn kho phần thợ đã dùng thật.
      if (hold.requestId && outbound) {
        await tx.productionMaterialRequest.update({
          where: { id: hold.requestId },
          data: { outboundId: outbound.id },
        });
      }
    }
  }

  /**
   * Thủ kho nhận lại túi đá thợ trả giữa khâu Vào đá (đổi size — đá không vừa sản phẩm): cân túi
   * trả, phần trả theo tỷ lệ TL nhả khỏi giữ chỗ ngay để cấp cho việc khác. Thợ xin túi size mới
   * theo luồng xin thêm. Phần trả không còn tính là đá đã phát cho thợ khi QC tính hao hụt.
   */
  async returnStoneEarly(
    code: string,
    stageId: string,
    dto: EarlyStoneReturnDto,
    actor: AuthUserPayload,
  ) {
    return this.mutate(code, async (tx, order) => {
      const entry = requireStage(order, stageId);
      const ticket = order.subTickets.find(
        (item) => item.id === entry.subTicketId,
      );
      if (entry.stage !== ProductionStage.STONE_SETTING || !ticket) {
        throw new BadRequestException(
          'Chỉ khâu Vào đá của phiếu con mới nhận lại túi đá giữa khâu',
        );
      }
      if (entry.returnedAt) {
        throw new BadRequestException(
          'QC đã nhận lại khâu này — đá thừa cân ở bước QC',
        );
      }
      if (entry.craftsmanUserId === actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Thợ không tự nhận lại đá của mình — nhờ thủ kho cân túi trả',
        );
      }
      const holds = await tx.productionStoneHold.findMany({
        where: {
          stageEntryId: entry.id,
          materialId: dto.materialId,
          status: 'HELD',
        },
        orderBy: { createdAt: 'asc' },
        include: {
          material: {
            select: { name: true, unit: { select: { name: true } } },
          },
        },
      });
      if (holds.length === 0) {
        throw new BadRequestException(
          'Mã đá này không có túi đang giữ cho khâu — không nhận lại được',
        );
      }
      const material = holds[0].material;
      const plan = planEarlyReturn(
        holds,
        new Prisma.Decimal(dto.weight),
        isCountUnit(material.unit.name),
      );
      const zero = new Prisma.Decimal(0);
      for (const item of plan) {
        const { hold } = item;
        // Trả hết túi thì dòng giữ chỗ nhả hẳn.
        const emptied = item.qty.lte(0) || item.weight.lte(0);
        await tx.productionStoneHold.update({
          where: { id: hold.id },
          data: {
            qty: item.qty,
            stoneCount: item.stoneCount,
            weight: item.weight,
            earlyReturnedWeight: (hold.earlyReturnedWeight ?? zero).add(
              item.returnedWeight,
            ),
            earlyReturnedQty: (hold.earlyReturnedQty ?? zero).add(
              item.returnedQty,
            ),
            earlyReturnedCount:
              item.returnedCount != null
                ? (hold.earlyReturnedCount ?? 0) + item.returnedCount
                : hold.earlyReturnedCount,
            ...(emptied ? { status: 'RELEASED', usedCount: 0 } : {}),
          },
        });
        // Phiếu xuất nháp còn phần thợ đang giữ; trả hết thì huỷ phiếu.
        if (hold.draftId) {
          await this.inventory.shrinkOutboundDraft(
            tx,
            hold.draftId,
            { qty: emptied ? zero : item.qty, gramQty: item.weight },
            actorName(actor),
          );
        }
      }
      const returnedQty = plan.reduce(
        (sum, item) => sum.add(item.returnedQty),
        zero,
      );
      const counted = plan.filter((item) => item.returnedCount != null);
      await logActivity(tx, order.id, actor, ACTIVITY.STONE_RETURN_EARLY, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: entry.stage,
        after: {
          name: material.name,
          weight: dto.weight,
          qty: decStr(returnedQty),
          unit: material.unit.name,
          stoneCount: counted.length
            ? counted.reduce((sum, item) => sum + (item.returnedCount ?? 0), 0)
            : null,
        },
        note: dto.note,
      });
    }).then((detail) => {
      // Phần trả nhả khỏi giữ chỗ — số khả dụng ở màn kho đổi theo.
      this.inventory.bustNvlStock();
      return detail;
    });
  }

  /**
   * Thủ kho bấm "Tạo phiếu bù" cho hàng lỗi QC đã tách ở Nguội / Vào đá (đã được xác nhận): sinh
   * một đơn tạo bù SL = số lỗi, đi lại từ bước sáp (sao chép khuôn / 3D / đá từ đơn tạo gốc). Đúc
   * xong thì hệ thống tạo phiếu con mới trên đơn này, không sinh đơn A mới. Mỗi lần QC nhận lại
   * chỉ bù một lần.
   */
  async createRework(code: string, stageId: string, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      const entry = requireStage(order, stageId);
      const ticket = order.subTickets.find(
        (item) => item.id === entry.subTicketId,
      );
      if (!ticket || !KEEPER_CONFIRM_STAGES.includes(entry.stage)) {
        throw new BadRequestException(
          'Chỉ tạo phiếu bù cho hàng lỗi ở khâu Nguội / Vào đá',
        );
      }
      if (!entry.confirmedAt) {
        throw new BadRequestException(
          'Thủ kho xác nhận khâu này rồi mới tạo phiếu bù được',
        );
      }
      const defectQty = entry.defectQty ?? 0;
      if (defectQty <= 0) {
        throw new BadRequestException('Khâu này không có hàng lỗi để bù');
      }
      if (order.intakeSeq == null) {
        throw new BadRequestException(
          `Đơn ${order.code} không sinh từ đơn tạo nên không tạo phiếu bù tự động được`,
        );
      }
      const existing = await tx.productionOrder.findUnique({
        where: { reworkOfEntryId: entry.id },
        select: { code: true, intakeCode: true },
      });
      if (existing) {
        throw new BadRequestException(
          `Đã có phiếu bù ${existing.intakeCode ?? existing.code} cho lần QC nhận lại này`,
        );
      }

      const seq = await nextOrderSeq(tx);
      const intakeSeq = await nextIntakeSeq(tx);
      const label = ticketCode(order, ticket);
      // Đá theo 3D chia theo tỷ lệ số lượng bù trên số lượng đơn gốc.
      const ratio = order.qty > 0 ? defectQty / order.qty : 1;
      const rework = await tx.productionOrder.create({
        data: {
          seq,
          code: orderCode(seq),
          intakeSeq,
          intakeCode: intakeCode(intakeSeq),
          sxCode: randomSxCode(),
          // Đã có khuôn / 3D: bỏ qua duyệt và vẽ 3D, vào thẳng bước sáp.
          status: ProductionStatus.READY_FOR_PRODUCTION,
          source: ProductionSource.NVL,
          requestType: order.requestType,
          productName: order.productName,
          qty: defectQty,
          trackingCode: order.trackingCode,
          model3dCode: order.model3dCode,
          closedBy: actorName(actor),
          createdBy: actorName(actor),
          createdByUserId: actor.id,
          description: `[Bù cho ${label}] ${order.description}`.trim(),
          receivedDate: todayVn(),
          dueDate: order.dueDate,
          hasMold: order.hasMold,
          model3dUrl: order.model3dUrl,
          productWeightGram: order.productWeightGram,
          stoneCount:
            order.stoneCount != null
              ? Math.round(order.stoneCount * ratio)
              : null,
          stoneWeight: order.stoneWeight
            ? order.stoneWeight.mul(ratio).toDecimalPlaces(4)
            : null,
          reworkOfOrderId: order.id,
          reworkOfSubTicketId: ticket.id,
          reworkOfEntryId: entry.id,
        },
        select: { code: true, intakeCode: true },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.TICKET_REWORK, {
        orderCode: order.code,
        subTicketNo: ticket.no,
        stage: entry.stage,
        after: { qty: defectQty, intakeCode: rework.intakeCode },
        note: `Tạo phiếu bù ${rework.intakeCode} cho ${defectQty} sp lỗi — đi lại từ bước sáp`,
      });
      await touch(tx, order.id);
    });
  }

  /**
   * Thủ kho đánh dấu đơn không có đá (mô tả luồng bước 17): các phiếu đã nguội xong sang thẳng
   * O Chờ khắc, bỏ khâu Vào đá. Bỏ đánh dấu được khi chưa phiếu nào giao khâu sau Vào đá.
   */
  async setStoneSkipped(code: string, skip: boolean, actor: AuthUserPayload) {
    return this.mutate(code, async (tx, order) => {
      assertOrderActive(order);
      if (!IN_STAGE_STATUSES.includes(order.status)) {
        throw new BadRequestException(
          `Đơn ${order.code} đang ${STATUS_LABEL[order.status]} — chỉ đánh dấu không có đá khi đơn đang ở các khâu`,
        );
      }
      if (order.stoneSkipped === skip) {
        throw new BadRequestException(
          skip
            ? 'Đơn đã được đánh dấu không có đá'
            : 'Đơn chưa được đánh dấu không có đá',
        );
      }
      const stone = ProductionStage.STONE_SETTING;
      if (skip) {
        const pending =
          order.pendingStage === stone ||
          order.subTickets.some((ticket) => ticket.pendingStage === stone);
        if (pending) {
          throw new BadRequestException(
            'Đơn đang có phiếu mở khâu Vào đá — huỷ mở khâu (nhả đá đã cấp) trước khi đánh dấu không có đá',
          );
        }
        if (order.stages.some((entry) => entry.stage === stone)) {
          throw new BadRequestException(
            'Đơn đã có phiếu giao khâu Vào đá — không đánh dấu không có đá được',
          );
        }
      } else {
        if (order.stoneCount === 0) {
          throw new BadRequestException(
            'Đơn có 0 viên đá trên 3D nên luôn bỏ khâu Vào đá — sửa số viên đá trên đơn nếu cần vào đá',
          );
        }
        const after = (stage: ProductionStage | null) =>
          stage != null &&
          STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(stone);
        if (
          order.stages.some((entry) => after(entry.stage)) ||
          after(order.pendingStage) ||
          order.subTickets.some((ticket) => after(ticket.pendingStage))
        ) {
          throw new BadRequestException(
            'Đơn đã có phiếu giao khâu sau Vào đá — không bỏ đánh dấu được',
          );
        }
      }

      const by = actorName(actor);
      const now = new Date();
      const status = deriveOrderStatus({ ...order, stoneSkipped: skip });
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          stoneSkipped: skip,
          stoneSkippedAt: skip ? now : null,
          stoneSkippedByName: skip ? by : null,
          status,
          dataChangedAt: now,
          statusLogs:
            status === order.status
              ? undefined
              : {
                  create: {
                    fromStatus: order.status,
                    toStatus: status,
                    note: skip
                      ? 'Thủ kho đánh dấu đơn không có đá — bỏ khâu Vào đá'
                      : 'Thủ kho bỏ đánh dấu không có đá — đơn đi lại khâu Vào đá',
                    changedBy: by,
                  },
                },
        },
      });
      await logActivity(
        tx,
        order.id,
        actor,
        skip ? ACTIVITY.STONE_SKIP : ACTIVITY.STONE_UNSKIP,
        {
          orderCode: order.code,
          stage: stone,
          before: { stoneSkipped: !skip, status: order.status },
          after: { stoneSkipped: skip, status },
        },
      );
    });
  }

  /** Tính lại trạng thái đơn sau khi thủ kho xác nhận / gỡ xác nhận (đọc lại từ DB trong tx). */
  private async syncOrderAfterStage(
    tx: Prisma.TransactionClient,
    orderId: string,
    actor: AuthUserPayload,
    outcomeChanged: boolean,
  ) {
    const load = () =>
      tx.productionOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: detailInclude,
      });
    let fresh = await load();
    if (
      outcomeChanged ||
      DEFECT_STATUSES.includes(fresh.status) ||
      fresh.status === S.FINISHING
    ) {
      await this.syncOrder(tx, fresh, actor);
      fresh = await load();
    }
    const status = deriveOrderStatus(fresh);
    if (status === fresh.status) {
      await touch(tx, orderId);
      return;
    }
    await tx.productionOrder.update({
      where: { id: orderId },
      data: {
        status,
        dataChangedAt: new Date(),
        statusLogs: {
          create: {
            fromStatus: fresh.status,
            toStatus: status,
            note: 'Thủ kho xác nhận sau QC',
            changedBy: actorName(actor),
          },
        },
      },
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
          'Chỉ thợ đã nhận, người lên đơn, thủ kho hoặc admin được gỡ lượt nhận',
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

  /** Người điều hành chọn khâu, chỉ định thợ và giao việc trực tiếp cho một phiếu con. */
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
        'Cắt cây thông (cân phôi) cho đơn trước khi giao khâu cho thợ',
      );
      const ticket = requireSubTicket(order, no);
      const entries = entriesOf(order, ticket.id);
      const { state } = subTicketState(ticket, entries);
      const stage = ticket.pendingStage;
      const craftsmanUserId = ticket.claimedByUserId;
      if (!stage || !craftsmanUserId || state !== 'CLAIMED') {
        throw new BadRequestException(
          `Phiếu ${ticketCode(order, ticket)} chưa sẵn sàng để giao việc`,
        );
      }
      // Nguội / Vào đá đi theo luồng mới: thủ kho chỉ định thợ, thợ quét QR bấm "Nhận hàng" —
      // hệ thống tự xuất BTP (và đá đã giữ chỗ ở Vào đá) nên không còn bước chọn NVL tay ở đây.
      if (
        stage === ProductionStage.FILING ||
        stage === ProductionStage.STONE_SETTING
      ) {
        throw new BadRequestException(
          `Khâu ${STAGE_LABEL[stage]} không xác nhận giao tay — thủ kho chỉ định thợ rồi thợ quét QR bấm "Nhận hàng"`,
        );
      }
      // Cân bạc lúc giao cần hai người: người giao và thợ nhận. Riêng admin được tự xác
      // nhận cho mình — bản ghi khâu vẫn ghi người giao = thợ nên xem lại vẫn biết lần đó
      // chỉ có một người cân.
      if (craftsmanUserId === actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Thợ không tự xác nhận giao cho mình — nhờ người giao cân bạc và xác nhận',
        );
      }
      const craftsman = await tx.user.findFirst({
        where: { id: craftsmanUserId, isActive: true },
        select: { id: true, fullName: true, username: true },
      });
      if (!craftsman) {
        throw new BadRequestException(
          'Tài khoản thợ được chọn không còn hoạt động',
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
          'Thời gian giao không được trước lúc QC nhận lại khâu trước',
        );
      }

      const craftsmanName = actorName(craftsman);
      const changedBy = actorName(actor);
      await tx.productionSubTicket.update({
        where: { id: ticket.id },
        data: CLEAR_PENDING,
      });
      const handedSilver = handedSilverOf(dto, entries);
      // TL giao không vượt hàng đang có (QC nhận lại khâu trước / phôi sau đúc).
      assertHandedSilverWithin(order, ticket.id, handedSilver);
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
          handedSilverWeight: handedSilver,
          ...handedStoneOf(stage, dto, order),
          craftsmanUserId: craftsman.id,
          craftsmanName,
          note: dto.note?.trim() || null,
        },
      });
      // Phiếu con đi lệch khâu nhau nên không đặt trạng thái đơn theo phiếu vừa giao —
      // đơn lấy trạng thái của phiếu đi xa nhất (xem deriveOrderStatus).
      const nextStatus = deriveOrderStatus({
        // Vừa giao khâu nên đơn chắc chắn đang ở một khâu, kể cả khi làm lại từ Lỗi.
        status: S.FILING,
        stoneCount: order.stoneCount,
        stoneSkipped: order.stoneSkipped,
        pendingStage: null,
        claimedByUserId: null,
        subTickets: order.subTickets.map((other) =>
          other.id === ticket.id ? { ...other, ...CLEAR_PENDING } : other,
        ),
        stages: [...order.stages, created],
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
   * Chỉ chốt khi phiếu không còn khâu đang chạy — QC cân lại xong mới phán đạt / lỗi.
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

  /**
   * QC nhận lại 0 sản phẩm ở khâu không qua thủ kho: phiếu con chốt Lỗi ngay trong transaction
   * của lần nhận lại, đơn mẹ tính lại trạng thái (mọi phiếu con lỗi thì Sản xuất lỗi).
   */
  async closeTicketAsDefect(
    tx: Prisma.TransactionClient,
    target: {
      orderId: string;
      orderCode: string;
      ticketId: string;
      ticketNo: number;
      stage: ProductionStage;
      note: string;
    },
    actor: AuthUserPayload,
  ) {
    await tx.productionSubTicket.update({
      where: { id: target.ticketId },
      data: {
        ...CLEAR_PENDING,
        outcome: SubTicketOutcome.DEFECT,
        outcomeAt: new Date(),
        outcomeByUserId: actor.id,
        outcomeByName: actorName(actor),
        outcomeStage: target.stage,
        outcomeQty: null,
        outcomeNote: target.note,
      },
    });
    await logActivity(tx, target.orderId, actor, ACTIVITY.TICKET_OUTCOME, {
      orderCode: target.orderCode,
      subTicketNo: target.ticketNo,
      stage: target.stage,
      after: { outcome: SubTicketOutcome.DEFECT, outcomeQty: null },
      note: target.note,
    });
    await this.syncOrderAfterStage(tx, target.orderId, actor, true);
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
        outcomeStage: true,
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
      status = finishedQty > 0 ? S.FINISHING : defectStatusOf(tickets);
      note = `${finished.length}/${tickets.length} phiếu con hoàn thiện — ${finishedQty} sp chờ nhập kho thành phẩm`;
    } else if (
      order.status === S.FINISHING ||
      DEFECT_STATUSES.includes(order.status)
    ) {
      // Gỡ kết cục một phiếu: đơn quay lại trạng thái của phiếu đi xa nhất còn đang chạy.
      status =
        furthestStatus(
          tickets.map((ticket) =>
            ticketStatus(
              ticket,
              entriesOf(order, ticket.id),
              lastOf(order.stages.filter((entry) => !entry.subTicketId))
                ?.stage ?? null,
              skipsStone(order),
            ),
          ),
        ) ?? S.CASTING;
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
    } else if (order.subTickets.length > 1) {
      throw new BadRequestException(
        'Đơn đã chia phiếu con — quét mã phiếu con để nhận việc',
      );
    }
    return toDetail(order);
  }

  /**
   * Thợ báo đã làm xong khâu đang giữ và nộp hàng cho QC. Chỉ là tín hiệu để QC biết
   * phiếu nào tới lượt mình — QC vẫn nhận lại được cả khi thợ chưa bấm.
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

  /** Bấm nhầm thì bỏ báo xong — chính thợ đó hoặc admin, khi QC chưa nhận lại. */
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
          select: {
            id: true,
            code: true,
            source: true,
            castingSentDate: true,
            cutAt: true,
          },
        },
      },
    });
    if (!ticket) throw new NotFoundException('Không tìm thấy phiếu con');
    if (
      ticket.order.source === 'NVL' &&
      !ticket.order.castingSentDate &&
      !ticket.order.cutAt
    ) {
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
    // Phiếu đang mở chỉ hiện cho thợ làm đúng khâu đó; admin thấy hết.
    const adminView = isAdmin(actor);
    const stages = adminView ? null : await stagesOf(this.prisma, actor);
    const openStage = stages ? { in: stages } : { not: null };
    const castingHeldStatuses: CastingSlipStatus[] = [
      CastingSlipStatus.CASTING,
      CastingSlipStatus.PENDING_CONFIRMATION,
      CastingSlipStatus.PENDING_ISSUE,
    ];
    // Phiếu mẹ chạy đúng bốn nhánh như phiếu con, mỗi nhánh một câu truy vấn riêng. Gộp
    // chung một câu rồi lọc trong bộ nhớ thì `take` sẽ dùng chung: phiếu người khác đang mở
    // đủ nhiều là đẩy mất việc của chính thợ ra khỏi danh sách.
    const castingSlipSelect = {
      id: true,
      code: true,
      status: true,
      slipDate: true,
      batchOrderCodes: true,
      waxWeightGram: true,
      issueS999Gram: true,
      issueMasterAlloyGram: true,
      issueS925Gram: true,
      startedAt: true,
      confirmedAt: true,
      _count: { select: { orders: true } },
    } as const;

    const [
      claimed,
      working,
      recent,
      parentAvailable,
      parentClaimed,
      parentWorking,
      parentRecent,
      castingAvailable,
      castingMine,
      castingRecent,
    ] = await Promise.all([
      this.prisma.productionSubTicket.findMany({
        // Thủ kho chỉ định thợ (không có phiếu mở để thợ tự nhận); admin thấy mọi phiếu đang giữ.
        where: adminView
          ? { claimedByUserId: { not: null }, pendingStage: { not: null } }
          : { claimedByUserId: actor.id, pendingStage: { not: null } },
        include: myTicketInclude,
        orderBy: { claimedAt: 'asc' },
        ...(adminView ? { take: MINE_LIMIT } : {}),
      }),
      this.prisma.productionStageEntry.findMany({
        where: adminView
          ? { subTicketId: { not: null }, returnedAt: null }
          : {
              craftsmanUserId: actor.id,
              subTicketId: { not: null },
              returnedAt: null,
            },
        include: {
          ...entryRequestsSelect,
          subTicket: { include: myTicketInclude },
        },
        orderBy: { handedAt: 'asc' },
        ...(adminView ? { take: MINE_LIMIT } : {}),
      }),
      this.prisma.productionStageEntry.findMany({
        where: adminView
          ? { subTicketId: { not: null }, returnedAt: { not: null } }
          : {
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
          pendingStage: openStage,
          claimedByUserId: null,
          status: { not: S.DELIVERED },
        },
        select: myOrderPendingSelect,
        orderBy: { pendingAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionOrder.findMany({
        where: adminView
          ? {
              subTickets: { none: {} },
              claimedByUserId: { not: null },
              pendingStage: { not: null },
            }
          : {
              subTickets: { none: {} },
              claimedByUserId: actor.id,
              pendingStage: { not: null },
            },
        select: myOrderPendingSelect,
        orderBy: { claimedAt: 'asc' },
        ...(adminView ? { take: MINE_LIMIT } : {}),
      }),
      this.prisma.productionStageEntry.findMany({
        where: adminView
          ? {
              subTicketId: null,
              returnedAt: null,
              order: { subTickets: { none: {} } },
            }
          : {
              craftsmanUserId: actor.id,
              subTicketId: null,
              returnedAt: null,
              // Đơn đã chia thì việc đi theo phiếu con; thẻ phiếu mẹ sẽ dẫn tới ngõ cụt.
              order: { subTickets: { none: {} } },
            },
        select: myOrderEntrySelect,
        orderBy: { handedAt: 'asc' },
        ...(adminView ? { take: MINE_LIMIT } : {}),
      }),
      this.prisma.productionStageEntry.findMany({
        where: adminView
          ? {
              subTicketId: null,
              returnedAt: { not: null },
              order: { subTickets: { none: {} } },
            }
          : {
              craftsmanUserId: actor.id,
              subTicketId: null,
              returnedAt: { not: null },
              order: { subTickets: { none: {} } },
            },
        select: myOrderEntrySelect,
        orderBy: { returnedAt: 'desc' },
        take: RECENT_LIMIT,
      }),
      this.prisma.castingSlip.findMany({
        where: adminView
          ? { status: CastingSlipStatus.WAIT_CASTING, startedAt: null }
          : {
              startedByUserId: actor.id,
              status: CastingSlipStatus.WAIT_CASTING,
              startedAt: null,
            },
        select: castingSlipSelect,
        orderBy: [{ slipDate: 'desc' }, { code: 'desc' }],
        ...(adminView ? { take: AVAILABLE_LIMIT } : {}),
      }),
      this.prisma.castingSlip.findMany({
        where: adminView
          ? { status: { in: castingHeldStatuses } }
          : {
              startedByUserId: actor.id,
              status: { in: castingHeldStatuses },
            },
        select: castingSlipSelect,
        orderBy: [{ slipDate: 'desc' }, { code: 'desc' }],
        ...(adminView ? { take: AVAILABLE_LIMIT } : {}),
      }),
      this.prisma.castingSlip.findMany({
        where: adminView
          ? { status: CastingSlipStatus.DONE }
          : { startedByUserId: actor.id, status: CastingSlipStatus.DONE },
        select: castingSlipSelect,
        orderBy: { confirmedAt: 'desc' },
        take: RECENT_LIMIT,
      }),
    ]);

    return {
      /** Khâu tài khoản này được nhận; admin nhận mọi khâu. */
      stages: stages ?? Object.values(ProductionStage),
      available: [...parentAvailable.map((order) => parentPendingItem(order))],
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
      castingAvailable: castingAvailable.map(castingSlipMyItem),
      castingMine: castingMine.map(castingSlipMyItem),
      castingRecent: castingRecent.map(castingSlipMyItem),
    };
  }

  /**
   * Màn "Phiếu QC": việc của QC theo nhóm — đang làm (QC báo lỗi được), chờ QC cân lại, chờ thủ kho xác nhận (còn sửa lại
   * được), chờ hoàn thiện (đã qua Xi) và các lần QC gần đây. Trả mọi khâu, màn tự lọc theo khâu.
   * QC không thao tác trong chi tiết lệnh nữa nên đây là nơi duy nhất QC làm việc.
   */
  async qcTickets(actor: AuthUserPayload) {
    const notDelivered = { status: { not: S.DELIVERED } };
    // Thợ đã báo làm xong, hoặc khâu đã bị báo lỗi — khớp điều kiện nhận lại ở returnStage.
    const waitingQc = {
      returnedAt: null,
      OR: [{ submittedAt: { not: null } }, { defectReportedAt: { not: null } }],
    } satisfies Prisma.ProductionStageEntryWhereInput;
    const subInclude = {
      ...entryRequestsSelect,
      subTicket: { include: myTicketInclude },
    } satisfies Prisma.ProductionStageEntryInclude;
    const parentSelect = {
      ...myOrderEntrySelect,
      ...qcEntrySelect,
    } satisfies Prisma.ProductionStageEntrySelect;
    // Admin xem mọi lần QC gần đây; QC chỉ xem lần mình cân.
    const mine = isAdmin(actor) ? {} : { returnedByUserId: actor.id };
    // Đã qua Xi và không còn khâu nào đang chạy.
    const doneLastStage = {
      some: { stage: LAST_STAGE, returnedAt: { not: null } },
      none: { returnedAt: null },
    } satisfies Prisma.ProductionStageEntryListRelationFilter;

    const [
      working,
      subPending,
      parentPending,
      confirming,
      finishTickets,
      finishOrders,
      subRecent,
      parentRecent,
    ] = await Promise.all([
      // Thợ còn đang làm ở phiếu con — QC thấy hàng hỏng thì báo lỗi luôn (stage-defect theo phiếu con).
      this.prisma.productionStageEntry.findMany({
        where: {
          returnedAt: null,
          submittedAt: null,
          defectReportedAt: null,
          subTicketId: { not: null },
          order: notDelivered,
        },
        include: subInclude,
        orderBy: { handedAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          ...waitingQc,
          subTicketId: { not: null },
          order: notDelivered,
        },
        include: subInclude,
        orderBy: { handedAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          ...waitingQc,
          subTicketId: null,
          order: { ...notDelivered, subTickets: { none: {} } },
        },
        select: parentSelect,
        orderBy: { handedAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          subTicketId: { not: null },
          stage: { in: KEEPER_CONFIRM_STAGES },
          returnedAt: { not: null },
          confirmedAt: null,
          order: notDelivered,
        },
        include: subInclude,
        orderBy: { returnedAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionSubTicket.findMany({
        where: {
          outcome: null,
          pendingStage: null,
          order: notDelivered,
          stages: doneLastStage,
        },
        include: myTicketInclude,
        orderBy: { updatedAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionOrder.findMany({
        where: {
          subTickets: { none: {} },
          receipt: { is: null },
          pendingStage: null,
          status: { notIn: [S.DELIVERED, S.NEW, S.REDO_3D] },
          stages: doneLastStage,
        },
        select: {
          ...myOrderCardSelect,
          stages: {
            where: { subTicketId: null },
            orderBy: { createdAt: 'asc' },
            select: { stage: true, returnedAt: true, returnedQty: true },
          },
        },
        orderBy: { updatedAt: 'asc' },
        take: AVAILABLE_LIMIT,
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          ...mine,
          subTicketId: { not: null },
          returnedAt: { not: null },
        },
        include: subInclude,
        orderBy: { returnedAt: 'desc' },
        take: RECENT_LIMIT,
      }),
      this.prisma.productionStageEntry.findMany({
        where: {
          ...mine,
          subTicketId: null,
          returnedAt: { not: null },
          order: { subTickets: { none: {} } },
        },
        select: parentSelect,
        orderBy: { returnedAt: 'desc' },
        take: RECENT_LIMIT,
      }),
    ]);

    const subItem = (entry: (typeof subPending)[number]) =>
      entry.subTicket
        ? [{ ...entryItem(entry.subTicket, entry), ...qcExtras(entry) }]
        : [];
    const parentItem = (entry: (typeof parentPending)[number]) => ({
      ...parentEntryItem(entry),
      ...qcExtras(entry),
    });

    return {
      working: working.flatMap(subItem),
      pending: [
        ...parentPending.map(parentItem),
        ...subPending.flatMap(subItem),
      ],
      confirming: confirming.flatMap(subItem),
      finishable: [
        ...finishOrders
          .filter((order) => lastStageDone(order.stages))
          .map((order) => ({
            ...parentBaseItem(order),
            stage: LAST_STAGE,
            // Vào kho là số QC nhận lại ở khâu cuối — cùng nguồn với finish().
            qty: lastOf(order.stages)?.returnedQty ?? order.qty,
            doneAt: lastOf(order.stages)?.returnedAt?.toISOString() ?? null,
          })),
        ...finishTickets
          .filter((row) => lastStageDone(row.stages))
          .map((row) => ({
            ...baseItem(row),
            stage: LAST_STAGE,
            qty: subTicketAvailable(row, row.stages).qty,
            doneAt: lastOf(row.stages)?.returnedAt?.toISOString() ?? null,
          })),
      ],
      recent: recentFirst(
        [...parentRecent.map(parentItem), ...subRecent.flatMap(subItem)],
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
  WORKING: 'được thợ làm, chờ QC nhận lại',
  SUBMITTED: 'thợ đã báo xong, chờ QC cân lại',
  CONFIRMING: 'chờ thủ kho xác nhận sau QC',
  DEFECT: 'ở nhánh Lỗi',
  FINISH: 'ở nhánh Hoàn thiện',
} as const;

const OUTCOME_LABEL: Record<SubTicketOutcome, string> = {
  DEFECT: 'lỗi',
  FINISH: 'hoàn thiện',
};

function castingSlipMyItem(row: {
  id: string;
  code: string;
  status: CastingSlipStatus;
  slipDate: Date;
  batchOrderCodes: string;
  waxWeightGram: Prisma.Decimal;
  issueS999Gram: Prisma.Decimal | null;
  issueMasterAlloyGram: Prisma.Decimal | null;
  issueS925Gram: Prisma.Decimal | null;
  startedAt: Date | null;
  confirmedAt: Date | null;
  _count: { orders: number };
}) {
  let issueTotal = new Prisma.Decimal(0);
  for (const part of [
    row.issueS999Gram,
    row.issueMasterAlloyGram,
    row.issueS925Gram,
  ]) {
    if (part != null) issueTotal = issueTotal.add(part);
  }
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    slipDate: row.slipDate.toISOString().slice(0, 10),
    batchOrderCodes: row.batchOrderCodes,
    waxWeightGram: decStr(row.waxWeightGram),
    issueTotalGram: decStr(issueTotal),
    orderCount: row._count.orders,
    startedAt: row.startedAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

function isAdmin(actor: AuthUserPayload) {
  return userHasRole(actor.roleCode, actor.extraRoles ?? [], RoleCode.ADMIN);
}

/** Khâu tài khoản được nhận, đọc từ DB để admin đổi khâu là có hiệu lực ngay. `null` = admin, nhận mọi khâu. */
async function stagesOf(
  db: PrismaService | Prisma.TransactionClient,
  actor: AuthUserPayload,
): Promise<ProductionStage[] | null> {
  if (isAdmin(actor)) return null;
  const user = await db.user.findUnique({
    where: { id: actor.id },
    select: { workerStages: true },
  });
  return user?.workerStages ?? [];
}

async function assertCanTakeStage(
  tx: Prisma.TransactionClient,
  actor: AuthUserPayload,
  stage: ProductionStage | null,
) {
  if (!stage) return;
  const stages = await stagesOf(tx, actor);
  if (stages && !stages.includes(stage)) {
    throw new ForbiddenException(
      `Bạn chưa được giao khâu ${STAGE_LABEL[stage]} — nhờ admin thêm khâu ở màn Nhân sự`,
    );
  }
}

/**
 * Số lượng đá theo đơn vị của mã: mã tính theo viên thì bằng số viên theo nhãn gói; mã tính
 * theo ct / gram suy từ TL gói (g) — 1 ct = 0,2 g.
 */
function stoneQtyOf(
  material: { name: string; unit: { name: string } },
  stoneCount: number | null | undefined,
  weight: Prisma.Decimal,
) {
  const unit = material.unit.name.trim().toLowerCase();
  if (isCountUnit(unit)) {
    // Tồn của mã trừ theo viên nên phải biết số viên — mã ct / g thì chỉ cần TL gói.
    if (!stoneCount) {
      throw new BadRequestException(
        `${material.name} tính tồn theo viên — nhập số viên theo nhãn gói`,
      );
    }
    return new Prisma.Decimal(stoneCount);
  }
  if (unit === 'ct') return weight.div(0.2).toDecimalPlaces(4);
  if (['g', 'gr', 'gram', 'grams', 'gam'].includes(unit)) return weight;
  throw new BadRequestException(
    `${material.name} tính theo ${material.unit.name} — chưa hỗ trợ cấp đá theo đơn vị này`,
  );
}

/**
 * Lý do chốt Lỗi tự động khi QC xác nhận 100% hàng lỗi: ai báo, lý do thợ / QC đã ghi, và số
 * liệu cân (số lượng, trọng lượng hàng lỗi, nguyên liệu thừa) để xem phiếu là hiểu ngay.
 */
function defectNoteOf(
  entry: {
    defectReportedByName: string | null;
    defectNote: string | null;
    defectReason: string | null;
    defectQty: number | null;
    handedQty: number | null;
    btpRecoveredWeight: Prisma.Decimal | null;
    silverRecoveredWeight: Prisma.Decimal | null;
    scrapS999Weight: Prisma.Decimal | null;
    returnedByName: string | null;
    note: string | null;
  },
  stageName: string,
) {
  const parts: string[] = [];
  if (entry.defectNote) {
    parts.push(
      `Lý do: ${entry.defectNote}${entry.defectReportedByName ? ` (báo bởi ${entry.defectReportedByName})` : ''}`,
    );
  }
  if (entry.defectReason) parts.push(`QC ghi lỗi: ${entry.defectReason}`);
  const qty = entry.defectQty ?? entry.handedQty;
  const weight = entry.btpRecoveredWeight
    ? ` · ${decStr(entry.btpRecoveredWeight)} g`
    : '';
  parts.push(
    `QC${entry.returnedByName ? ` ${entry.returnedByName}` : ''} cân: toàn bộ ${qty ?? '—'} sp lỗi${weight} (đạt 0 sp)`,
  );
  const scraps = [
    entry.silverRecoveredWeight?.gt(0)
      ? `S925 thừa ${decStr(entry.silverRecoveredWeight)} g`
      : '',
    entry.scrapS999Weight?.gt(0)
      ? `S999 thừa ${decStr(entry.scrapS999Weight)} g`
      : '',
  ].filter(Boolean);
  if (scraps.length) parts.push(scraps.join(' · '));
  if (entry.note) parts.push(`Ghi chú: ${entry.note}`);
  return `Lỗi khâu ${stageName}. ${parts.join('. ')}`.slice(0, 500);
}

/** Khâu kế tiếp theo thứ tự luồng; chưa làm khâu nào thì là Nguội, qua Xi thì null. */
function nextStageAfter(stage: ProductionStage | null): ProductionStage | null {
  if (!stage) return STAGE_ORDER[0];
  return STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1] ?? null;
}

/** Phiếu còn nguyên: chưa mở khâu, chưa giao thợ, chưa chốt, chưa xin NVL. */
function isUntouched(order: OrderDetail, ticket: SubTicket) {
  return (
    entriesOf(order, ticket.id).length === 0 &&
    !ticket.pendingStage &&
    !ticket.claimedByUserId &&
    !ticket.outcome &&
    !order.materialRequests.some((request) => request.subTicketId === ticket.id)
  );
}

function canManage(
  order: Pick<OrderDetail, 'createdByUserId'>,
  actor: AuthUserPayload,
) {
  return (
    userHasRole(actor.roleCode, actor.extraRoles ?? [], RoleCode.ADMIN) ||
    // Bước 11: thủ kho chia phiếu và giao khâu cho thợ.
    userCan(actor, Permission.WAREHOUSE_KEEPER) ||
    (order.createdByUserId != null && order.createdByUserId === actor.id)
  );
}

function assertManager(
  order: Pick<OrderDetail, 'createdByUserId'>,
  actor: AuthUserPayload,
) {
  if (!canManage(order, actor)) {
    throw new ForbiddenException(
      'Chỉ người lên đơn, thủ kho hoặc admin được chia phiếu con',
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
      'Chỉ người lên đơn, thủ kho hoặc admin được chọn NVL và xác nhận giao khâu',
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
  const totalQty = others.reduce(
    (sum, ticket) => sum + ticketNetQty(order, ticket),
    qty,
  );
  if (totalQty > order.qty) {
    throw new BadRequestException(
      `Tổng số lượng phiếu con (${totalQty}) vượt số lượng đơn (${order.qty})`,
    );
  }
}

/** Tách mã phiếu con "A012-2" → đơn A012, phiếu số 2. */
function parseTicketCode(value: string) {
  const match = /^(.+)-(\d+)$/.exec(normalizeCode(value));
  if (!match) return null;
  return { orderCode: match[1], no: Number(match[2]) };
}

function ticketCode(
  order: Pick<OrderDetail, 'code' | 'subTickets'>,
  ticket: Pick<SubTicket, 'no'>,
) {
  return subTicketCode(order.code, ticket.no, order.subTickets.length);
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

function baseItem(row: MyTicketRow) {
  return {
    scope: 'SUB_TICKET' as const,
    ticketCode: subTicketCode(
      row.order.code,
      row.no,
      row.order._count.subTickets,
    ),
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
        /** Đá hiện TL theo ct, bạc theo g. */
        kind: request.kind,
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
