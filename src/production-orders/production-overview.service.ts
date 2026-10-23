import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CastingSlipStatus,
  Prisma,
  ProductionStatus,
  RoleCode,
} from '@prisma/client';
import { Permission } from '../auth/permissions';
import { poolAll } from '../prisma/pool-all';
import { PrismaService } from '../prisma/prisma.service';
import { decStr } from '../util/money';
import { InflightMap, TtlCache } from '../util/ttl-cache';
import { KEEPER_CONFIRM_STAGES } from './order-detail';
import type {
  ProductionOverviewQuery,
  WorkerPerformanceQuery,
} from './dto/production-order.dto';
import {
  addDayKey,
  bucketIndexByDay,
  compareWatch,
  OVERVIEW_MAX_BUCKETS,
  OVERVIEW_MAX_DAYS,
  overviewBuckets,
  previousPeriod,
  type OverviewGroup,
  dateKey,
  isFirstPass,
  isOverdue,
  OVERVIEW_STAGES,
  OVERVIEW_STATUSES,
  overviewOrderSelect,
  orderPositions,
  vnDayKey,
  vnDayStart,
  WORKER_STAGE_KEYS,
  batchCodes,
  CASTING_SLIP_PERFORMANCE,
  PERFORMANCE_STAGES,
  returnedItems,
  workerPerformance,
  type PerformanceItem,
  type PerformanceStageKey,
} from './production-overview';
import { ACTIVITY } from './activity-log';
import { issuedOf, silverInOf } from './stage-math';

const OVERVIEW_TTL_MS = 20_000;
/** Mặc định màn Tổng quan: 7 ngày gần nhất, xem theo ngày. */
const DEFAULT_DAYS = 7;
/** Bảng Phiếu cần theo dõi phân trang ở FE — gửi đủ phiếu đang trong xưởng, chặn trên cho an toàn. */
const WATCH_LIMIT = 1000;
const PERFORMANCE_MAX_DAYS = 366;

/** Nhật ký thao tác 3D / sáp → khâu trên bảng hiệu suất. */
const MODEL_ACTION_STAGE: Record<string, PerformanceStageKey> = {
  [ACTIVITY.MODEL3D_DONE]: 'MODEL3D',
  [ACTIVITY.WAX_DONE]: 'WAX',
  [ACTIVITY.WAX_TREE_DONE]: 'WAX',
};

/**
 * Một đơn hàng tính một lần: bỏ phiếu bù (dùng lại mã DH của đơn gốc) và bản ghi tồn kho đầu kỳ
 * (KHO-…).
 */
const ORDER_SCOPE: Prisma.ProductionOrderWhereInput = {
  reworkOfOrderId: null,
  OR: [
    { trackingCode: null },
    { NOT: { trackingCode: { startsWith: 'KHO-' } } },
  ],
};

@Injectable()
export class ProductionOverviewService {
  private readonly cache = new TtlCache();
  private readonly inflight = new InflightMap();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Màn Tổng quan sản xuất — một lần gọi đủ số cho cả trang, cache ngắn. Thành phẩm, kế hoạch và
   * QC tính theo kỳ đang xem (kèm kỳ trước để so sánh); trong xưởng, quá hạn, công đoạn, vật tư là
   * số hiện tại.
   */
  async overview(query: ProductionOverviewQuery = {}) {
    const now = new Date();
    const today = vnDayKey(now);
    const group: OverviewGroup = query.groupBy ?? 'day';
    const to = query.to ?? today;
    const from = query.from ?? addDayKey(to, 1 - DEFAULT_DAYS);
    if (from > to) {
      throw new BadRequestException('Ngày bắt đầu phải trước ngày kết thúc');
    }
    if (Date.parse(to) - Date.parse(from) >= OVERVIEW_MAX_DAYS * 86_400_000) {
      throw new BadRequestException(
        `Chỉ xem tối đa ${OVERVIEW_MAX_DAYS} ngày một lần`,
      );
    }
    if (overviewBuckets(from, to, group).length > OVERVIEW_MAX_BUCKETS) {
      throw new BadRequestException(
        'Kỳ quá dài để xem theo ngày — chọn xem theo tuần hoặc tháng',
      );
    }
    const key = `overview:${from}:${to}:${group}`;
    const hit = this.cache.get<Awaited<ReturnType<typeof this.build>>>(key);
    if (hit) return hit;
    return this.inflight.run(key, async () => {
      const value = await this.build(now, { from, to, group });
      this.cache.set(key, value, OVERVIEW_TTL_MS);
      return value;
    });
  }

  /**
   * Hiệu suất thợ theo khâu và trạng thái. Hoàn thiện / lỗi tính theo lúc QC nhận lại trong khoảng
   * ngày (giờ Việt Nam); chưa làm / đang làm là việc đang nằm ở thợ lúc xem. Tính cả phiếu bù — thợ
   * vẫn làm thật; bỏ đơn tồn đầu kỳ (KHO-…) và đơn đã giao.
   */
  async workerPerformance(query: WorkerPerformanceQuery) {
    const from = vnDayStart(query.from);
    const to = vnDayStart(query.to, 1);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException('Khoảng ngày không hợp lệ');
    }
    if (
      to.getTime() - from.getTime() >
      PERFORMANCE_MAX_DAYS * 24 * 60 * 60 * 1000
    ) {
      throw new BadRequestException(
        `Chỉ xem tối đa ${PERFORMANCE_MAX_DAYS} ngày một lần`,
      );
    }
    const scope: Prisma.ProductionOrderWhereInput = {
      status: { not: ProductionStatus.DELIVERED },
      OR: [
        { trackingCode: null },
        { NOT: { trackingCode: { startsWith: 'KHO-' } } },
      ],
    };
    const [
      returned,
      open,
      claimedTickets,
      claimedOrders,
      workers,
      modelLogs,
      slips,
      failedSlips,
    ] = await poolAll([
      // Hoàn thiện / lỗi: QC nhận lại trong khoảng ngày.
      () =>
        this.prisma.productionStageEntry.findMany({
          where: { returnedAt: { gte: from, lt: to }, order: scope },
          select: {
            orderId: true,
            stage: true,
            craftsmanUserId: true,
            craftsmanName: true,
            returnedQty: true,
            defectQty: true,
          },
        }),
      // Đang làm: khâu đã giao, QC chưa nhận lại — số hiện tại, không theo khoảng ngày.
      () =>
        this.prisma.productionStageEntry.findMany({
          where: { returnedAt: null, order: scope },
          select: {
            orderId: true,
            stage: true,
            craftsmanUserId: true,
            craftsmanName: true,
            handedQty: true,
            subTicket: { select: { qty: true } },
            order: { select: { qty: true } },
          },
        }),
      // Chưa làm: thợ đã nhận / được chỉ định, chờ người giao xác nhận — số hiện tại.
      () =>
        this.prisma.productionSubTicket.findMany({
          where: {
            outcome: null,
            pendingStage: { not: null },
            claimedByUserId: { not: null },
            order: scope,
          },
          select: {
            orderId: true,
            qty: true,
            pendingStage: true,
            claimedByUserId: true,
            claimedByName: true,
          },
        }),
      () =>
        this.prisma.productionOrder.findMany({
          where: {
            ...scope,
            subTickets: { none: {} },
            pendingStage: { not: null },
            claimedByUserId: { not: null },
          },
          select: {
            id: true,
            qty: true,
            pendingStage: true,
            claimedByUserId: true,
            claimedByName: true,
          },
        }),
      // Thợ = role Thợ, tick quyền Thợ (khớp danh sách giao khâu), thợ 3D, thợ sáp, thợ đúc;
      // admin chỉ hiện khi có việc.
      () =>
        this.prisma.user.findMany({
          where: {
            isActive: true,
            OR: [
              { roleCode: RoleCode.WORKER },
              { extraRoles: { has: RoleCode.WORKER } },
              {
                allowedScreens: {
                  hasSome: [
                    Permission.PRODUCTION_WORKER,
                    Permission.PRODUCTION_MODEL3D,
                    Permission.PRODUCTION_WAX,
                    Permission.PRODUCTION_CAST,
                  ],
                },
              },
            ],
          },
          select: {
            id: true,
            fullName: true,
            workerStages: true,
            allowedScreens: true,
          },
        }),
      // 3D / Sáp: chỉ có nhật ký từ lúc bắt đầu ghi người làm — đơn làm trước đó không có.
      () =>
        this.prisma.productionActivityLog.findMany({
          where: {
            action: { in: Object.keys(MODEL_ACTION_STAGE) },
            createdAt: { gte: from, lt: to },
            order: scope,
          },
          select: {
            orderId: true,
            action: true,
            actorUserId: true,
            actorName: true,
            order: { select: { qty: true } },
          },
        }),
      // Đúc: phiếu đang giao / đang đúc (số hiện tại) và phiếu thủ kho xác nhận trong khoảng ngày.
      () =>
        this.prisma.castingSlip.findMany({
          where: {
            startedByUserId: { not: null },
            OR: [
              {
                status: {
                  in: [
                    CastingSlipStatus.PENDING_ISSUE,
                    CastingSlipStatus.WAIT_CASTING,
                    CastingSlipStatus.CASTING,
                    CastingSlipStatus.PENDING_CONFIRMATION,
                  ],
                },
              },
              {
                status: CastingSlipStatus.DONE,
                confirmedAt: { gte: from, lt: to },
              },
            ],
          },
          select: {
            status: true,
            startedByUserId: true,
            startedByName: true,
            orders: {
              select: { orderId: true, order: { select: { qty: true } } },
            },
          },
        }),
      // Phiếu đúc lỗi: đơn đã dời sang phiếu làm lại, chỉ còn chuỗi mã đơn trên phiếu.
      () =>
        this.prisma.castingSlip.findMany({
          where: {
            status: CastingSlipStatus.CAST_FAILED,
            rejectedAt: { gte: from, lt: to },
          },
          select: {
            startedByUserId: true,
            startedByName: true,
            batchOrderCodes: true,
          },
        }),
    ]);
    const failedCodes = [
      ...new Set(
        failedSlips.flatMap((slip) => batchCodes(slip.batchOrderCodes)),
      ),
    ];
    const failedOrders = failedCodes.length
      ? await this.prisma.productionOrder.findMany({
          where: { intakeCode: { in: failedCodes }, reworkOfOrderId: null },
          select: { id: true, intakeCode: true, qty: true },
        })
      : [];
    const orderByCode = new Map(
      failedOrders.map((order) => [order.intakeCode!, order]),
    );
    const items: PerformanceItem[] = [
      ...returned.flatMap(returnedItems),
      ...open.map((entry) => ({
        orderId: entry.orderId,
        stage: entry.stage,
        workerId: entry.craftsmanUserId,
        workerName: entry.craftsmanName,
        status: 'WORKING' as const,
        qty: entry.handedQty ?? entry.subTicket?.qty ?? entry.order.qty,
      })),
      ...[
        ...claimedTickets,
        ...claimedOrders.map(({ id, ...order }) => ({ ...order, orderId: id })),
      ].map((claim) => ({
        orderId: claim.orderId,
        stage: claim.pendingStage!,
        workerId: claim.claimedByUserId,
        workerName: claim.claimedByName ?? '—',
        status: 'PENDING' as const,
        qty: claim.qty,
      })),
      ...modelLogs.map((log) => ({
        orderId: log.orderId!,
        stage: MODEL_ACTION_STAGE[log.action],
        workerId: log.actorUserId,
        workerName: log.actorName,
        status: 'DONE' as const,
        qty: log.order?.qty ?? 0,
      })),
      ...slips.flatMap((slip) =>
        slip.orders.map((line) => ({
          orderId: line.orderId,
          stage: 'CASTING' as const,
          workerId: slip.startedByUserId,
          workerName: slip.startedByName ?? '—',
          status: CASTING_SLIP_PERFORMANCE[slip.status]!,
          qty: line.order.qty,
        })),
      ),
      ...failedSlips.flatMap((slip) =>
        batchCodes(slip.batchOrderCodes).flatMap((code) => {
          const order = orderByCode.get(code);
          return order
            ? [
                {
                  orderId: order.id,
                  stage: 'CASTING' as const,
                  workerId: slip.startedByUserId,
                  workerName: slip.startedByName ?? '—',
                  status: 'DEFECT' as const,
                  qty: order.qty,
                },
              ]
            : [];
        }),
      ),
    ];
    return {
      from: query.from,
      to: query.to,
      stages: PERFORMANCE_STAGES,
      ...workerPerformance(
        items,
        workers.map((worker) => ({
          id: worker.id,
          fullName: worker.fullName,
          stages: [
            ...(worker.allowedScreens.includes(Permission.PRODUCTION_MODEL3D)
              ? (['MODEL3D', 'WAX'] as const)
              : []),
            ...(worker.allowedScreens.includes(Permission.PRODUCTION_WAX)
              ? (['WAX'] as const)
              : []),
            ...(worker.allowedScreens.includes(Permission.PRODUCTION_CAST)
              ? (['CASTING'] as const)
              : []),
            ...worker.workerStages,
          ],
        })),
      ),
    };
  }

  private async build(
    now: Date,
    period: { from: string; to: string; group: OverviewGroup },
  ) {
    const todayKey = vnDayKey(now);
    const buckets = overviewBuckets(period.from, period.to, period.group);
    const previous = previousPeriod(period.from, period.to, period.group);
    const previousBuckets = overviewBuckets(
      previous.from,
      previous.to,
      period.group,
    );
    // Một lần đọc cho cả kỳ trước lẫn kỳ đang xem.
    const rangeStart = vnDayStart(previous.from);
    const rangeEnd = vnDayStart(period.to, 1);

    const [
      orders,
      receipts,
      planned,
      qcEntries,
      openEntries,
      stones,
      keeperPending,
    ] = await poolAll([
      () =>
        this.prisma.productionOrder.findMany({
          where: { ...ORDER_SCOPE, status: { in: OVERVIEW_STATUSES } },
          select: overviewOrderSelect,
        }),
      // Kho nhận theo phiếu nhập của đơn: `receivedAt` là lần thủ kho xác nhận gần nhất.
      () =>
        this.prisma.finishedGoodsReceipt.findMany({
          where: {
            receivedAt: { gte: rangeStart, lt: rangeEnd },
            stockedQty: { gt: 0 },
            order: ORDER_SCOPE,
          },
          select: { stockedQty: true, receivedAt: true },
        }),
      // Kế hoạch mốc = tổng SL các lệnh có hạn giao trong mốc (đơn bị từ chối không tính).
      () =>
        this.prisma.productionOrder.findMany({
          where: {
            ...ORDER_SCOPE,
            status: { not: ProductionStatus.REJECTED },
            dueDate: {
              gte: new Date(`${previous.from}T00:00:00Z`),
              lte: new Date(`${period.to}T00:00:00Z`),
            },
          },
          select: { qty: true, dueDate: true },
        }),
      () =>
        this.prisma.productionStageEntry.findMany({
          where: { returnedAt: { gte: rangeStart, lt: rangeEnd } },
          select: {
            attempt: true,
            defectQty: true,
            defectReportedAt: true,
            returnedAt: true,
          },
        }),
      // Bạc đang ở thợ: khâu chưa trả, gồm TL giao lúc nhận + bạc xin xuất thêm.
      () =>
        this.prisma.productionStageEntry.findMany({
          where: { returnedAt: null },
          select: {
            handedSilverWeight: true,
            materialRequests: {
              select: {
                status: true,
                kind: true,
                issuedWeight: true,
                issuedStoneCount: true,
              },
            },
          },
        }),
      () =>
        this.prisma.productionStoneHold.aggregate({
          where: { status: 'HELD' },
          _sum: { weight: true },
        }),
      // Khớp hàng chờ thủ kho trên màn Phiếu QC: phiếu mẹ của đơn chưa chia + phiếu con.
      () =>
        this.prisma.productionStageEntry.count({
          where: {
            stage: { in: KEEPER_CONFIRM_STAGES },
            returnedAt: { not: null },
            confirmedAt: null,
            order: { status: { not: ProductionStatus.DELIVERED } },
            OR: [
              { subTicketId: { not: null } },
              { subTicketId: null, order: { subTickets: { none: {} } } },
            ],
          },
        }),
    ]);

    const positions = orders.flatMap(orderPositions);
    const stages = OVERVIEW_STAGES.map(({ key, label }) => ({
      key,
      label,
      waiting: 0,
      working: 0,
    }));
    const stageIndex = new Map(stages.map((stage) => [stage.key, stage]));
    const overdueByStage = new Map<string, number>();
    let inShopQty = 0;
    let openTickets = 0;
    for (const position of positions) {
      const stage = stageIndex.get(position.stage)!;
      if (position.working) stage.working += position.qty;
      else stage.waiting += position.qty;
      inShopQty += position.qty;
      if (WORKER_STAGE_KEYS.includes(position.stage)) openTickets += 1;
      if (isOverdue(position, todayKey)) {
        overdueByStage.set(
          position.stage,
          (overdueByStage.get(position.stage) ?? 0) + 1,
        );
      }
    }

    // Mỗi mốc kỳ này đi cặp với mốc cùng vị trí của kỳ trước.
    const trend = buckets.map((bucket) => ({
      ...bucket,
      actual: 0,
      plan: 0,
      qcPassed: 0,
      qcTotal: 0,
      previousActual: 0,
    }));
    const current = bucketIndexByDay(buckets);
    const before = bucketIndexByDay(previousBuckets);
    const totals = {
      actual: 0,
      plan: 0,
      qcPassed: 0,
      qcTotal: 0,
      previousActual: 0,
      previousPlan: 0,
      previousQcPassed: 0,
      previousQcTotal: 0,
    };
    for (const receipt of receipts) {
      const day = vnDayKey(receipt.receivedAt);
      const i = current.get(day);
      if (i != null) {
        trend[i].actual += receipt.stockedQty;
        totals.actual += receipt.stockedQty;
        continue;
      }
      const j = before.get(day);
      if (j != null) {
        if (trend[j]) trend[j].previousActual += receipt.stockedQty;
        totals.previousActual += receipt.stockedQty;
      }
    }
    for (const order of planned) {
      if (!order.dueDate) continue;
      const day = dateKey(order.dueDate);
      const i = current.get(day);
      if (i != null) {
        trend[i].plan += order.qty;
        totals.plan += order.qty;
      } else if (before.has(day)) {
        totals.previousPlan += order.qty;
      }
    }
    for (const entry of qcEntries) {
      const day = vnDayKey(entry.returnedAt!);
      const passed = isFirstPass(entry) ? 1 : 0;
      const i = current.get(day);
      if (i != null) {
        trend[i].qcTotal += 1;
        trend[i].qcPassed += passed;
        totals.qcTotal += 1;
        totals.qcPassed += passed;
      } else if (before.has(day)) {
        totals.previousQcTotal += 1;
        totals.previousQcPassed += passed;
      }
    }

    let silver = new Prisma.Decimal(0);
    for (const entry of openEntries) {
      const silverIn = silverInOf(
        entry,
        issuedOf(entry.materialRequests).metal,
      );
      if (silverIn) silver = silver.add(silverIn);
    }

    const overdue = positions.filter((p) => isOverdue(p, todayKey));
    const watch = [...positions].sort(compareWatch).slice(0, WATCH_LIMIT);

    return {
      generatedAt: now.toISOString(),
      today: todayKey,
      period: {
        from: period.from,
        to: period.to,
        groupBy: period.group,
        previousFrom: previous.from,
        previousTo: previous.to,
      },
      kpis: {
        inShop: { qty: inShopQty, openTickets },
        finished: {
          qty: totals.actual,
          planQty: totals.plan,
          previousQty: totals.previousActual,
          previousPlanQty: totals.previousPlan,
        },
        overdue: {
          count: overdue.length,
          byStage: OVERVIEW_STAGES.filter(({ key }) =>
            overdueByStage.has(key),
          ).map(({ key, label }) => ({
            stage: key,
            label,
            count: overdueByStage.get(key)!,
          })),
        },
        qcFirstPass: {
          passed: totals.qcPassed,
          total: totals.qcTotal,
          previousPassed: totals.previousQcPassed,
          previousTotal: totals.previousQcTotal,
        },
      },
      stages,
      trend,
      materials: {
        silverAtWorkersG: decStr(silver),
        stonesHeldG: decStr(stones._sum.weight ?? new Prisma.Decimal(0)),
        pendingKeeperConfirm: keeperPending,
      },
      tickets: watch.map((position) => ({
        ...position,
        overdue: isOverdue(position, todayKey),
      })),
    };
  }
}
