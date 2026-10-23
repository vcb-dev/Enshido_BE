import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CastingSlipStatus,
  LossMetal,
  LossStage,
  OrderMetalType,
  Prisma,
  RoleCode,
} from '@prisma/client';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { InventoryService } from '../inventory/inventory.service';
import { poolAll } from '../prisma/pool-all';
import { PrismaService } from '../prisma/prisma.service';
import { actorName, subTicketCode } from '../production-orders/order-detail';
import { issuedOf, silverInOf } from '../production-orders/stage-math';
import type {
  CreateScrapReturnDto,
  LossReportQuery,
  UpdateLossLimitsDto,
} from './dto/loss-report.dto';
import {
  addDaysKey,
  buildLossReport,
  LOSS_REPORT_MAX_WEEKS,
  LOSS_STAGE_ORDER,
  percentOf,
  vnStart,
  weekKeys,
  weekOf,
  weekStartKey,
  type LossItem,
} from './loss-report';

/** Cùng mã với phần còn lại của cây sau đúc — tồn bạc thu hồi gom một chỗ. */
const SCRAP_MATERIAL_NAME = 'Bạc thu hồi / đầu cây S925';

/** Báo cáo giai đoạn này chỉ tính bạc (đơn bạc S925 hoặc đơn cũ chưa chọn kim loại). */
const SILVER_ORDER: Prisma.ProductionOrderWhereInput = {
  OR: [{ metalType: null }, { metalType: OrderMetalType.SILVER_925 }],
  AND: [
    {
      OR: [
        { trackingCode: null },
        { NOT: { trackingCode: { startsWith: 'KHO-' } } },
      ],
    },
  ],
};

const dec = (value: Prisma.Decimal | null) =>
  value == null ? null : value.toString();

/** Phiếu đúc vàng có TL vàng cấp — không tính vào báo cáo bạc. */
const SILVER_SLIP: Prisma.CastingSlipWhereInput = {
  isServiceCast: false,
  silverUsedGram: { not: null },
  castTreeWeightGram: { not: null },
  OR: [{ issueGoldGram: null }, { issueGoldGram: 0 }],
};

@Injectable()
export class LossReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Hao hụt bạc theo tuần (thứ Hai → Chủ nhật, giờ Việt Nam) của từng thợ ở từng khâu. Một lượt
   * khâu tính vào tuần nó được chốt số (`confirmedAt`): Nguội / Vào đá lúc thủ kho xác nhận, khâu
   * khác lúc QC nhận lại. Khắc chỉ chụp ảnh nên không có số — hao Khắc nằm gộp ở Đánh bóng (lượt
   * Bóng trước 2026-10-23 cũng chưa cân, hao các lượt đó nằm ở Xi).
   * Đúc tính theo ngày cắt cây (thủ kho xác nhận phiếu đúc).
   */
  async weekly(query: LossReportQuery) {
    const weeks = weekKeys(query.from, query.to);
    if (weeks.length === 0) {
      throw new BadRequestException('Tuần kết thúc phải sau tuần bắt đầu');
    }
    if (weeks.length > LOSS_REPORT_MAX_WEEKS) {
      throw new BadRequestException(
        `Chỉ xem tối đa ${LOSS_REPORT_MAX_WEEKS} tuần một lần`,
      );
    }
    const from = vnStart(weeks[0]);
    const to = vnStart(addDaysKey(weeks[weeks.length - 1], 7));

    const [entries, slips, scraps, limitRows, pending] = await poolAll([
      () =>
        this.prisma.productionStageEntry.findMany({
          where: {
            confirmedAt: { gte: from, lt: to },
            returnedSilverWeight: { not: null },
            order: SILVER_ORDER,
          },
          orderBy: { confirmedAt: 'asc' },
          select: {
            stage: true,
            attempt: true,
            craftsmanUserId: true,
            craftsmanName: true,
            confirmedAt: true,
            handedQty: true,
            handedSilverWeight: true,
            returnedSilverWeight: true,
            stoneWeight: true,
            btpRecoveredWeight: true,
            silverRecoveredWeight: true,
            scrapS999Weight: true,
            subTicket: { select: { no: true } },
            order: {
              select: {
                code: true,
                _count: { select: { subTickets: true } },
              },
            },
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
        this.prisma.castingSlip.findMany({
          where: {
            ...SILVER_SLIP,
            status: CastingSlipStatus.DONE,
            confirmedAt: { gte: from, lt: to },
          },
          orderBy: { confirmedAt: 'asc' },
          select: {
            code: true,
            confirmedAt: true,
            startedByUserId: true,
            startedByName: true,
            silverUsedGram: true,
            castTreeWeightGram: true,
            orders: { select: { blankQty: true } },
          },
        }),
      () =>
        this.prisma.scrapReturn.findMany({
          where: {
            weekStart: {
              gte: new Date(`${weeks[0]}T00:00:00Z`),
              lte: new Date(`${weeks[weeks.length - 1]}T00:00:00Z`),
            },
          },
          orderBy: [{ weekStart: 'asc' }, { receivedAt: 'asc' }],
        }),
      () => this.limitRows(),
      // QC đã nhận lại nhưng thủ kho chưa xác nhận: số còn sửa được, chưa tính vào tuần nào.
      () =>
        this.prisma.productionStageEntry.count({
          where: {
            returnedAt: { gte: from, lt: to },
            confirmedAt: null,
            order: SILVER_ORDER,
          },
        }),
    ]);

    const items: LossItem[] = [];
    for (const entry of entries) {
      const issued = issuedOf(entry.materialRequests);
      const silverIn = silverInOf(entry, issued.metal);
      if (silverIn == null || entry.returnedSilverWeight == null) continue;
      items.push({
        week: weekOf(entry.confirmedAt!),
        workerKey: entry.craftsmanUserId ?? `name:${entry.craftsmanName}`,
        workerUserId: entry.craftsmanUserId,
        workerName: entry.craftsmanName,
        stage: entry.stage,
        ticketCode: entry.subTicket
          ? subTicketCode(
              entry.order.code,
              entry.subTicket.no,
              entry.order._count.subTickets,
            )
          : entry.order.code,
        attempt: entry.attempt,
        confirmedAt: entry.confirmedAt!,
        qty: entry.handedQty ?? 0,
        inGram: silverIn,
        // Vào đá cân cả cụm bạc + đá: trừ TL đá gắn để cột hàng trả chỉ còn bạc.
        productGram: entry.returnedSilverWeight.sub(entry.stoneWeight ?? 0),
        btpGram: entry.btpRecoveredWeight ?? new Prisma.Decimal(0),
        nvlGram: (entry.silverRecoveredWeight ?? new Prisma.Decimal(0)).add(
          entry.scrapS999Weight ?? 0,
        ),
      });
    }
    for (const slip of slips) {
      items.push({
        week: weekOf(slip.confirmedAt!),
        workerKey: slip.startedByUserId ?? `name:${slip.startedByName ?? ''}`,
        workerUserId: slip.startedByUserId,
        workerName: slip.startedByName ?? '—',
        stage: LossStage.CASTING,
        ticketCode: slip.code,
        attempt: 1,
        confirmedAt: slip.confirmedAt!,
        qty: slip.orders.reduce((sum, row) => sum + (row.blankQty ?? 0), 0),
        // Hao hụt đúc = bạc đã dùng − cây thông sau đúc (giống báo cáo hao hụt đúc).
        inGram: slip.silverUsedGram!,
        productGram: slip.castTreeWeightGram!,
        btpGram: new Prisma.Decimal(0),
        nvlGram: new Prisma.Decimal(0),
      });
    }

    const limits = new Map(
      limitRows
        .filter((row) => row.metal === LossMetal.SILVER)
        .map((row) => [row.stage, row.percent]),
    );
    const scrapSums = scraps.map((row) => {
      const week = row.weekStart.toISOString().slice(0, 10);
      return {
        week,
        workerKey: row.craftsmanUserId,
        workerUserId: row.craftsmanUserId,
        workerName: row.craftsmanName,
        weightGram: row.weightGram,
      };
    });
    const workers = buildLossReport(items, scrapSums, limits);

    return {
      weeks: weeks.map((start) => ({ start, end: addDaysKey(start, 6) })),
      metal: LossMetal.SILVER,
      pendingCount: pending,
      limits: LOSS_STAGE_ORDER.map((stage) => ({
        stage,
        percent: dec(limits.get(stage) ?? null),
      })),
      workers: workers.map((row) => ({
        week: row.week,
        workerKey: row.workerKey,
        workerUserId: row.workerUserId,
        workerName: row.workerName,
        ...sumsOut(row),
        scrapGram: row.scrapGram.toString(),
        stages: row.stages.map((stage) => ({
          stage: stage.stage,
          ...sumsOut(stage),
        })),
      })),
      items: items
        .sort((a, b) => a.confirmedAt.getTime() - b.confirmedAt.getTime())
        .map((item) => {
          const loss = item.inGram
            .sub(item.productGram)
            .sub(item.btpGram)
            .sub(item.nvlGram);
          return {
            week: item.week,
            workerKey: item.workerKey,
            stage: item.stage,
            ticketCode: item.ticketCode,
            attempt: item.attempt,
            confirmedAt: item.confirmedAt.toISOString(),
            qty: item.qty,
            inGram: item.inGram.toString(),
            productGram: item.productGram.toString(),
            btpGram: item.btpGram.toString(),
            nvlGram: item.nvlGram.toString(),
            lossGram: loss.toString(),
            lossPercent: dec(percentOf(loss, item.inGram)),
          };
        }),
      scrapReturns: scraps.map((row) => ({
        id: row.id,
        week: row.weekStart.toISOString().slice(0, 10),
        workerKey: row.craftsmanUserId,
        workerName: row.craftsmanName,
        weightGram: row.weightGram.toString(),
        note: row.note,
        receivedAt: row.receivedAt.toISOString(),
        receivedByName: row.receivedByName,
      })),
    };
  }

  /** Mức hao hụt cho phép — đủ mọi khâu × kim loại, khâu chưa đặt mức thì `percent` null. */
  async limits() {
    const rows = await this.limitRows();
    const byKey = new Map(
      rows.map((row) => [`${row.stage}|${row.metal}`, row]),
    );
    return Object.values(LossMetal).flatMap((metal) =>
      LOSS_STAGE_ORDER.map((stage) => {
        const row = byKey.get(`${stage}|${metal}`);
        return {
          stage,
          metal,
          percent: dec(row?.percent ?? null),
          updatedByName: row?.updatedByName ?? null,
          updatedAt: row?.updatedAt.toISOString() ?? null,
        };
      }),
    );
  }

  async updateLimits(dto: UpdateLossLimitsDto, actor: AuthUserPayload) {
    const name = actorName(actor);
    await this.prisma.$transaction(async (tx) => {
      for (const limit of dto.limits) {
        if (limit.percent == null) {
          await tx.lossLimit.deleteMany({
            where: { stage: limit.stage, metal: limit.metal },
          });
          continue;
        }
        const percent = new Prisma.Decimal(limit.percent);
        await tx.lossLimit.upsert({
          where: { stage_metal: { stage: limit.stage, metal: limit.metal } },
          create: {
            stage: limit.stage,
            metal: limit.metal,
            percent,
            updatedByName: name,
          },
          update: { percent, updatedByName: name },
        });
      }
    });
    return this.limits();
  }

  /** Thợ nộp mạt được chọn: thợ khâu và thợ đúc (thợ 3D / sáp không cầm kim loại). */
  async workers() {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { roleCode: RoleCode.WORKER },
          { extraRoles: { has: RoleCode.WORKER } },
          {
            allowedScreens: {
              hasSome: [
                Permission.PRODUCTION_WORKER,
                Permission.PRODUCTION_CAST,
              ],
            },
          },
        ],
      },
      orderBy: [{ fullName: 'asc' }, { username: 'asc' }],
      select: { id: true, fullName: true, username: true, workerStages: true },
    });
  }

  /**
   * Thủ kho nhận mạt vụn thợ đã cô và cân trả: ghi vào tuần đã chọn và nhập kho NVL bạc thu hồi
   * cùng giao dịch.
   */
  async createScrapReturn(dto: CreateScrapReturnDto, actor: AuthUserPayload) {
    const week = weekStartKey(dto.week);
    if (week > weekOf(new Date())) {
      throw new BadRequestException('Không ghi mạt cho tuần chưa tới');
    }
    const worker = await this.prisma.user.findUnique({
      where: { id: dto.craftsmanUserId },
      select: { id: true, fullName: true, username: true, isActive: true },
    });
    if (!worker || !worker.isActive) {
      throw new BadRequestException('Thợ không tồn tại hoặc đã nghỉ');
    }
    const weight = new Prisma.Decimal(dto.weightGram);
    const workerName = actorName(worker);
    const receivedBy = actorName(actor);
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const materialId = await this.inventory.ensureNamedMaterial(tx, {
        warehouseCode: 'nvl-chinh',
        name: SCRAP_MATERIAL_NAME,
        unitCode: 'gram',
      });
      const inboundId = await this.inventory.createAutoInbound(tx, {
        materialId,
        qty: weight,
        gramQty: weight,
        receivedAt: now,
        note: `Mạt vụn thu hồi tuần ${weekLabel(week)} — ${workerName}`,
        enteredBy: receivedBy,
      });
      return tx.scrapReturn.create({
        data: {
          weekStart: new Date(`${week}T00:00:00Z`),
          craftsmanUserId: worker.id,
          craftsmanName: workerName,
          weightGram: weight,
          materialId,
          inboundId,
          note: dto.note?.trim() || null,
          receivedAt: now,
          receivedByUserId: actor.id,
          receivedByName: receivedBy,
        },
        select: { id: true },
      });
    });
    this.inventory.bustNvlStock();
    return row;
  }

  /** Xoá phiếu mạt ghi nhầm — gỡ luôn phiếu nhập kho; chặn khi mạt đã bị xuất dùng. */
  async removeScrapReturn(id: string) {
    const row = await this.prisma.scrapReturn.findUnique({
      where: { id },
      select: { id: true, inboundId: true },
    });
    if (!row) throw new NotFoundException('Không tìm thấy phiếu mạt');
    await this.prisma.$transaction(async (tx) => {
      if (row.inboundId) {
        await this.inventory.revokeAutoInbounds(tx, [row.inboundId]);
      }
      await tx.scrapReturn.delete({ where: { id } });
    });
    this.inventory.bustNvlStock();
    return { ok: true };
  }

  private limitRows() {
    return this.prisma.lossLimit.findMany();
  }
}

/** "20/10 – 26/10/2026" */
export function weekLabel(week: string) {
  const end = addDaysKey(week, 6);
  const [y, m, d] = week.split('-');
  const [ey, em, ed] = end.split('-');
  return y === ey
    ? `${d}/${m} – ${ed}/${em}/${ey}`
    : `${d}/${m}/${y} – ${ed}/${em}/${ey}`;
}

function sumsOut(row: {
  tickets: number;
  qty: number;
  inGram: Prisma.Decimal;
  productGram: Prisma.Decimal;
  btpGram: Prisma.Decimal;
  nvlGram: Prisma.Decimal;
  returnedGram: Prisma.Decimal;
  lossGram: Prisma.Decimal;
  lossPercent: Prisma.Decimal | null;
  limitPercent: Prisma.Decimal | null;
}) {
  return {
    tickets: row.tickets,
    qty: row.qty,
    inGram: row.inGram.toString(),
    productGram: row.productGram.toString(),
    btpGram: row.btpGram.toString(),
    nvlGram: row.nvlGram.toString(),
    returnedGram: row.returnedGram.toString(),
    lossGram: row.lossGram.toString(),
    lossPercent: dec(row.lossPercent),
    limitPercent: dec(row.limitPercent),
  };
}
