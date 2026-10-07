import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CastingSlipImageKind,
  CastingSlipStatus,
  Prisma,
  ProductionImageKind,
  ProductionStatus,
  RoleCode,
} from '@prisma/client';
import { userHasRole } from '../auth/permissions';
import { isCastWorkerAssignee } from '../auth/staff-job-presets';
import type { AuthUserPayload } from '../auth/types';
import { canConfirmIntakeWarehouse } from '../intake-orders/intake-warehouse-access';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { actorName } from '../production-orders/order-detail';
import { ACTIVITY, logActivity } from '../production-orders/activity-log';
import { toIntakeStatus } from '../production-orders/intake-order';
import { CloudinaryService } from '../uploads/cloudinary.service';
import {
  CastingLossQuery,
  ConfirmCastingSlipDto,
  CutCastingSlipItemDto,
  CastingSlipCandidatesQuery,
  CastingSlipResultDto,
  CreateCastingSlipDto,
  IssueCastingSlipDto,
  CastingSlipImageDto,
  ListCastingSlipsQuery,
} from './dto/casting-slip.dto';

const CODE_RETRIES = 8;
const SLIP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSlipCode() {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += SLIP_CHARS[Math.floor(Math.random() * SLIP_CHARS.length)];
  }
  return `D${suffix}`;
}

function parseDate(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${label} không hợp lệ`);
  }
  return date;
}

function parseOptionalDateOnly(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

/** Không có kết quả khớp — dùng với `id IN (...)` */
const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000';

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Mã mặc định nhận phần cây còn lại sau đúc (và hàng lỗi / S925 thừa ở Nguội, Vào đá). */
const REST_MATERIAL_NAME = 'Bạc thu hồi / đầu cây S925';

function isAdmin(actor: AuthUserPayload) {
  return userHasRole(actor.roleCode, actor.extraRoles ?? [], RoleCode.ADMIN);
}

@Injectable()
export class CastingSlipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly inventory: InventoryService,
  ) {}

  async list(query: ListCastingSlipsQuery) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 200);
    const filters = await this.buildListWhere(query, { skipStatus: true });
    const status = query.status?.trim();
    const rootWhere: Prisma.CastingSlipWhereInput = {
      AND: [
        { redoOfSlipId: null },
        filters,
        ...(status
          ? [
              {
                OR: [
                  { status: status as CastingSlipStatus },
                  { redos: { some: { status: status as CastingSlipStatus } } },
                ],
              },
            ]
          : []),
      ],
    };

    const [total, rows] = await Promise.all([
      this.prisma.castingSlip.count({ where: rootWhere }),
      this.prisma.castingSlip.findMany({
        where: rootWhere,
        orderBy: [{ slipDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: slipListInclude,
      }),
    ]);

    return { items: rows.map(toRow), total, page, pageSize };
  }

  async getById(id: string) {
    const row = await this.prisma.castingSlip.findUnique({
      where: { id },
      include: slipInclude,
    });
    if (!row) throw new NotFoundException('Không tìm thấy phiếu đúc');
    return toRow(row);
  }

  /** Thợ đúc quét QR trên phiếu giấy → mở phiếu theo mã. */
  async getByCode(code: string) {
    const row = await this.prisma.castingSlip.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: slipInclude,
    });
    if (!row) throw new NotFoundException(`Không tìm thấy phiếu đúc ${code}`);
    return toRow(row);
  }

  /** Bước 7: đơn đã có sáp (E), chưa lên phiếu đúc — thủ kho lọc để gom vào một lần đúc. */
  async candidates(query: CastingSlipCandidatesQuery) {
    const keyword = query.search?.trim();
    const contains = { contains: keyword, mode: 'insensitive' } as const;
    const rows = await this.prisma.productionOrder.findMany({
      where: {
        intakeSeq: { not: null },
        cutAt: null,
        status: ProductionStatus.WAX_CONFIRMED,
        castingSlipLine: null,
        ...(keyword
          ? {
              OR: [
                { intakeCode: contains },
                { sxCode: contains },
                { productName: contains },
                { trackingCode: contains },
              ],
            }
          : {}),
      },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { seq: 'asc' }],
      take: 200,
      select: {
        id: true,
        intakeCode: true,
        code: true,
        sxCode: true,
        productName: true,
        trackingCode: true,
        qty: true,
        dueDate: true,
        hasMold: true,
        productWeightGram: true,
        castingTreeWeightGram: true,
        waxCheckedWeightGram: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.intakeCode ?? row.code,
      sxCode: row.sxCode ?? row.code,
      productName: row.productName,
      trackingCode: row.trackingCode,
      qty: row.qty,
      dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
      hasMold: row.hasMold,
      waxWeightGram: dec(waxWeightOf(row)),
    }));
  }

  /**
   * Bước 7a: thủ kho lọc các đơn đã có sáp, gom vào một lần đúc, ghi bạc + hội theo định mức rồi
   * in phiếu. Phiếu ở Chờ cấp vật tư; đơn vẫn ở E nhưng đã giữ chỗ trên phiếu này.
   */
  async create(dto: CreateCastingSlipDto, actor: AuthUserPayload) {
    const ids = Array.from(new Set(dto.intakeOrderIds));
    if (ids.length !== dto.intakeOrderIds.length) {
      throw new BadRequestException('Một đơn chỉ chọn một lần trên phiếu');
    }
    const slipDate = parseDate(dto.slipDate, 'Ngày phiếu');
    const orders = await this.prisma.productionOrder.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        intakeCode: true,
        intakeSeq: true,
        cutAt: true,
        status: true,
        productWeightGram: true,
        castingTreeWeightGram: true,
        waxCheckedWeightGram: true,
        castingSlipLine: { select: { id: true } },
      },
    });
    const byId = new Map(orders.map((order) => [order.id, order]));
    const lines = ids.map((id, sortOrder) => {
      const order = byId.get(id);
      if (!order) throw new NotFoundException('Không tìm thấy đơn');
      const label = order.intakeCode ?? order.code;
      if (order.castingSlipLine) {
        throw new BadRequestException(
          `Đơn ${label} đã nằm trên phiếu đúc khác`,
        );
      }
      if (order.status !== ProductionStatus.WAX_CONFIRMED) {
        throw new BadRequestException(
          `Đơn ${label} chưa ở trạng thái Chờ SX · Đã có Sáp (E)`,
        );
      }
      const wax = waxWeightOf(order);
      if (wax == null || wax.lte(0)) {
        throw new BadRequestException(
          `Đơn ${label} thiếu trọng lượng sáp / cây thông`,
        );
      }
      return {
        orderId: id,
        sortOrder,
        waxWeightGram: wax,
        code: label,
      };
    });
    const waxWeightGram = lines.reduce(
      (sum, line) => sum.add(line.waxWeightGram),
      new Prisma.Decimal(0),
    );
    const createdByName = actorName(actor);
    const assignee = await this.resolveCastWorker(dto.assignedUserId);

    for (let attempt = 0; attempt < CODE_RETRIES; attempt++) {
      try {
        const slip = await this.prisma.runTx(async (tx) => {
          const row = await tx.castingSlip.create({
            data: {
              code: randomSlipCode(),
              slipDate,
              waxWeightGram,
              batchOrderCodes: lines.map((line) => line.code).join(', '),
              estimateS999Gram: silverEstimateFromWax(waxWeightGram),
              estimateMasterAlloyGram: silverEstimateFromWax(waxWeightGram),
              estimateS925Gram: silverEstimateFromWax(waxWeightGram),
              issueS999Gram: null,
              issueMasterAlloyGram: null,
              issueS925Gram: null,
              createdByName,
              startedByUserId: assignee.id,
              startedByName: assignee.name,
              status: CastingSlipStatus.PENDING_ISSUE,
              orders: {
                create: lines.map(
                  ({ orderId, sortOrder, waxWeightGram: wax }) => ({
                    orderId,
                    sortOrder,
                    waxWeightGram: wax,
                  }),
                ),
              },
            },
            select: { id: true },
          });
          // Hai phiếu cùng nhận một đơn thì unique `intake_order_id` chặn ở đây.
          return row;
        });
        return this.getById(slip.id);
      } catch (error) {
        if (isUniqueViolation(error) && attempt < CODE_RETRIES - 1) {
          // Trùng mã phiếu random thì thử mã khác; trùng đơn (unique intake) thì báo rõ.
          if (uniqueTarget(error).includes('order_id')) {
            throw new ConflictException(
              'Có đơn vừa được lên phiếu đúc khác — tải lại danh sách đơn',
            );
          }
          continue;
        }
        throw error;
      }
    }
    throw new BadRequestException('Không tạo được mã phiếu, thử lại');
  }

  /**
   * Bước 7b: đã in phiếu và cấp vật tư — thủ kho chụp ảnh phiếu đúc + vật tư kèm theo, ấn Lưu
   * → phiếu và mọi đơn trên phiếu sang Chờ đúc (F).
   */
  async issue(id: string, dto: IssueCastingSlipDto) {
    const images = this.normalizeImages(dto.images);
    if (images.length === 0) {
      throw new BadRequestException('Chụp ảnh phiếu đúc và vật tư kèm theo');
    }
    await this.prisma.runTx(async (tx) => {
      const slip = await tx.castingSlip.findUnique({
        where: { id },
        select: {
          waxWeightGram: true,
          estimateS999Gram: true,
          estimateMasterAlloyGram: true,
          estimateS925Gram: true,
          orders: { select: { orderId: true } },
        },
      });
      if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
      const issued = resolveIssuedGrams(slip, dto);
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: CastingSlipStatus.PENDING_ISSUE },
        data: {
          status: CastingSlipStatus.WAIT_CASTING,
          ...issued,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Phiếu đúc đã cấp vật tư rồi');
      }
      await tx.castingSlipImage.createMany({
        data: images.map((image) => ({
          ...image,
          slipId: id,
          kind: CastingSlipImageKind.ISSUE,
        })),
      });
      const ids = slip.orders.map((line) => line.orderId);
      const moved = await tx.productionOrder.updateMany({
        where: { id: { in: ids }, status: ProductionStatus.WAX_CONFIRMED },
        data: { status: ProductionStatus.WAIT_CASTING },
      });
      if (moved.count !== ids.length) {
        throw new ConflictException(
          'Có đơn trên phiếu không còn ở Chờ SX · Đã có sáp',
        );
      }
    });
    return this.getById(id);
  }

  /** Huỷ phiếu chưa cấp vật tư (lên nhầm đơn): các đơn trả về danh sách chờ đúc. */
  async remove(id: string) {
    const deleted = await this.prisma.castingSlip.deleteMany({
      where: { id, status: CastingSlipStatus.PENDING_ISSUE },
    });
    if (deleted.count !== 1) {
      throw new BadRequestException('Chỉ huỷ được phiếu đang chờ cấp vật tư');
    }
    return { success: true };
  }

  /**
   * Hao hụt đúc theo thợ đúc — chỉ tính phiếu thủ kho đã xác nhận Đúc xong, lọc theo ngày
   * xác nhận. Thợ = người bấm Bắt đầu đúc (người nhận phiếu).
   */
  async lossByWorker(query: CastingLossQuery) {
    const from = query.from ? parseDate(query.from, 'Từ ngày') : null;
    const to = query.to ? parseDate(query.to, 'Đến ngày') : null;
    if (to) to.setUTCHours(23, 59, 59, 999);
    const rows = await this.prisma.castingSlip.findMany({
      where: {
        status: CastingSlipStatus.DONE,
        ...(from || to
          ? {
              confirmedAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { confirmedAt: 'desc' },
      select: {
        id: true,
        code: true,
        confirmedAt: true,
        startedByUserId: true,
        startedByName: true,
        issueS999Gram: true,
        issueMasterAlloyGram: true,
        issueS925Gram: true,
        silverUsedGram: true,
        castTreeWeightGram: true,
      },
    });
    const zero = () => new Prisma.Decimal(0);
    const byWorker = new Map<
      string,
      {
        name: string;
        slips: number;
        issued: Prisma.Decimal;
        used: Prisma.Decimal;
        tree: Prisma.Decimal;
      }
    >();
    for (const row of rows) {
      if (row.silverUsedGram == null || row.castTreeWeightGram == null)
        continue;
      const key = row.startedByUserId ?? `name:${row.startedByName ?? ''}`;
      const acc = byWorker.get(key) ?? {
        name: row.startedByName ?? '—',
        slips: 0,
        issued: zero(),
        used: zero(),
        tree: zero(),
      };
      acc.slips += 1;
      acc.issued = acc.issued.add(issueTotal(row));
      acc.used = acc.used.add(row.silverUsedGram);
      acc.tree = acc.tree.add(row.castTreeWeightGram);
      byWorker.set(key, acc);
    }
    const workers = [...byWorker.entries()].map(([key, acc]) => {
      const loss = acc.used.sub(acc.tree);
      return {
        workerUserId: key.startsWith('name:') ? null : key,
        workerName: acc.name,
        slipCount: acc.slips,
        issuedGram: acc.issued.toString(),
        usedGram: acc.used.toString(),
        castTreeGram: acc.tree.toString(),
        lossGram: loss.toString(),
        lossPercent: acc.used.gt(0)
          ? loss.div(acc.used).mul(100).toDecimalPlaces(2).toString()
          : null,
      };
    });
    workers.sort((a, b) => Number(b.lossGram) - Number(a.lossGram));
    return {
      workers,
      slips: rows.map((row) => ({
        id: row.id,
        code: row.code,
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
        workerName: row.startedByName,
        issuedGram: issueTotal(row),
        ...castLossOf(row),
      })),
    };
  }

  async markPrinted(id: string) {
    await this.prisma.castingSlip.update({
      where: { id },
      data: { lastPrintedAt: new Date() },
    });
    return { success: true };
  }

  async listCastWorkers() {
    const rows = await this.prisma.user.findMany({
      where: { isActive: true },
      orderBy: [{ fullName: 'asc' }, { username: 'asc' }],
      select: {
        id: true,
        fullName: true,
        username: true,
        roleCode: true,
        extraRoles: true,
        allowedScreens: true,
      },
    });
    return rows
      .filter((user) => isCastWorkerAssignee(user))
      .map((user) => ({
        id: user.id,
        fullName: actorName(user),
        username: user.username,
      }));
  }

  private async resolveCastWorker(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: {
        id: true,
        fullName: true,
        username: true,
        roleCode: true,
        extraRoles: true,
        allowedScreens: true,
      },
    });
    if (!user || !isCastWorkerAssignee(user)) {
      throw new BadRequestException('Chỉ giao cho nhân sự có vai trò Thợ đúc');
    }
    return { id: user.id, name: actorName(user) };
  }

  /** Bước 8: thợ đúc quét phiếu + nguyên liệu, xác nhận bắt đầu đúc (F → G). */
  async start(id: string, actor: AuthUserPayload) {
    const slipBefore = await this.prisma.castingSlip.findUnique({
      where: { id },
      select: { startedByUserId: true, startedByName: true },
    });
    if (!slipBefore) throw new NotFoundException('Không tìm thấy phiếu đúc');
    // Admin thao tác thay được; phiếu vẫn giữ thợ đã giao để báo hao hụt đúng người.
    if (
      slipBefore.startedByUserId &&
      slipBefore.startedByUserId !== actor.id &&
      !isAdmin(actor)
    ) {
      throw new ForbiddenException('Phiếu đúc giao cho thợ khác');
    }
    const startedByName = slipBefore.startedByName ?? actorName(actor);
    const startedByUserId = slipBefore.startedByUserId ?? actor.id;
    await this.prisma.runTx(async (tx) => {
      const slip = await tx.castingSlip.findUnique({
        where: { id },
        select: { orders: { select: { orderId: true } } },
      });
      if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: CastingSlipStatus.WAIT_CASTING },
        data: {
          status: CastingSlipStatus.CASTING,
          startedAt: new Date(),
          startedByName,
          startedByUserId,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Phiếu đúc không ở trạng thái Chờ đúc');
      }
      await tx.productionOrder.updateMany({
        where: {
          id: { in: slip.orders.map((line) => line.orderId) },
          status: ProductionStatus.WAIT_CASTING,
        },
        data: { status: ProductionStatus.CASTING },
      });
    });
    return this.getById(id);
  }

  /** Bước 9: thợ đúc nhập ảnh cân cây thông + bạc/thạch cao đã dùng, chờ thủ kho (G → chờ xác nhận). */
  async submitResult(
    id: string,
    dto: CastingSlipResultDto,
    actor: AuthUserPayload,
  ) {
    const images = this.normalizeImages(dto.images);
    if (images.length === 0) {
      throw new BadRequestException('Chụp ảnh cân cây thông sau đúc');
    }
    const submittedByName = actorName(actor);
    const slip = await this.prisma.castingSlip.findUnique({
      where: { id },
      select: {
        issueS999Gram: true,
        issueMasterAlloyGram: true,
        issueS925Gram: true,
      },
    });
    if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
    // Giao ≥ bạc đã dùng ≥ cây thông sau đúc: phần giao chưa dùng trả kho, phần dùng mà
    // không thành cây là hao hụt đúc — không số nào được âm.
    const issued = new Prisma.Decimal(issueTotal(slip));
    const used = new Prisma.Decimal(dto.silverUsedGram);
    const tree = new Prisma.Decimal(dto.castTreeWeightGram);
    if (issued.gt(0) && used.gt(issued)) {
      throw new BadRequestException(
        `Bạc đã dùng (${used.toString()} g) vượt tổng vật tư giao (${issued.toString()} g)`,
      );
    }
    if (tree.gt(used)) {
      throw new BadRequestException(
        `TL cây thông sau đúc (${tree.toString()} g) không được nặng hơn bạc đã dùng (${used.toString()} g)`,
      );
    }
    await this.prisma.runTx(async (tx) => {
      const slipOrders = await tx.castingSlip.findUnique({
        where: { id },
        select: { orders: { select: { orderId: true } } },
      });
      if (!slipOrders) throw new NotFoundException('Không tìm thấy phiếu đúc');
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: CastingSlipStatus.CASTING },
        data: {
          status: CastingSlipStatus.PENDING_CONFIRMATION,
          castTreeWeightGram: new Prisma.Decimal(dto.castTreeWeightGram),
          silverUsedGram: new Prisma.Decimal(dto.silverUsedGram),
          plasterUsedGram: new Prisma.Decimal(dto.plasterUsedGram),
          submittedAt: new Date(),
          submittedByName,
          submittedByUserId: actor.id,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException(
          'Chỉ nhập kết quả khi phiếu đúc đang ở trạng thái Đang đúc',
        );
      }
      await tx.productionOrder.updateMany({
        where: {
          id: { in: slipOrders.orders.map((line) => line.orderId) },
          status: ProductionStatus.CASTING,
        },
        data: { status: ProductionStatus.CAST_PENDING_CONFIRMATION },
      });
      await tx.castingSlipImage.deleteMany({
        where: { slipId: id, kind: CastingSlipImageKind.RESULT },
      });
      await tx.castingSlipImage.createMany({
        data: images.map((image) => ({
          ...image,
          slipId: id,
          kind: CastingSlipImageKind.RESULT,
        })),
      });
    });
    return this.getById(id);
  }

  /** Thủ kho xác nhận số liệu thợ vừa nhập → Đúc xong. Cắt cây thông là bước sau. */
  async approveResult(id: string, actor: AuthUserPayload) {
    if (!canConfirmIntakeWarehouse(actor)) {
      throw new ForbiddenException('Chỉ thủ kho được xác nhận phiếu đúc');
    }
    const confirmedByName = actorName(actor);
    await this.prisma.runTx(async (tx) => {
      const slip = await tx.castingSlip.findUnique({
        where: { id },
        select: {
          status: true,
          castTreeWeightGram: true,
          orders: { select: { orderId: true } },
        },
      });
      if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
      if (slip.status !== CastingSlipStatus.PENDING_CONFIRMATION) {
        throw new BadRequestException('Phiếu đúc chưa chờ thủ kho xác nhận');
      }
      if (!slip.castTreeWeightGram || slip.castTreeWeightGram.lte(0)) {
        throw new BadRequestException('Chưa có số liệu thợ đúc nhập');
      }
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: CastingSlipStatus.PENDING_CONFIRMATION },
        data: {
          status: CastingSlipStatus.DONE,
          confirmedAt: new Date(),
          confirmedByName,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Phiếu đúc chưa chờ thủ kho xác nhận');
      }
      await tx.productionOrder.updateMany({
        where: {
          id: { in: slip.orders.map((line) => line.orderId) },
          status: {
            in: [
              ProductionStatus.CAST_PENDING_CONFIRMATION,
              ProductionStatus.CASTING,
            ],
          },
        },
        data: { status: ProductionStatus.CAST_DONE },
      });
    });
    return this.getById(id);
  }

  /** Cắt cây thông: nhập phôi theo từng lệnh và cho toàn bộ lô vào Nguội trong một giao dịch. */
  async confirm(
    id: string,
    dto: ConfirmCastingSlipDto,
    actor: AuthUserPayload,
  ) {
    const [updated] = await this.cutMany([{ slipId: id, ...dto }], actor);
    return updated;
  }

  async cutMany(items: CutCastingSlipItemDto[], actor: AuthUserPayload) {
    if (!items.length || items.length > 25) {
      throw new BadRequestException('Chọn từ 1 đến 25 phiếu đúc');
    }
    if (new Set(items.map((item) => item.slipId)).size !== items.length) {
      throw new BadRequestException('Mỗi phiếu đúc chỉ được chọn một lần');
    }
    await this.prisma.runTx(async (tx) => {
      for (const item of [...items].sort((a, b) =>
        a.slipId.localeCompare(b.slipId),
      )) {
        await this.cutInTransaction(tx, item.slipId, item, actor);
      }
    });
    this.inventory.bustBtpStock();
    if (items.some((item) => item.restWeightGram > 0))
      this.inventory.bustNvlStock();
    return Promise.all(items.map((item) => this.getById(item.slipId)));
  }

  private async cutInTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    dto: ConfirmCastingSlipDto,
    actor: AuthUserPayload,
  ) {
    if (!canConfirmIntakeWarehouse(actor)) {
      throw new ForbiddenException('Chỉ thủ kho được cắt cây thông');
    }
    const confirmedByName = actorName(actor);
    const restWeight = new Prisma.Decimal(dto.restWeightGram);
    const blanks = new Map(
      dto.blanks.map((line) => [line.intakeOrderId, line]),
    );
    if (blanks.size !== dto.blanks.length) {
      throw new BadRequestException('Mỗi đơn chỉ được chia phôi một lần');
    }
    if (restWeight.gt(0) && !dto.restImages.length) {
      throw new BadRequestException('Chụp ảnh cân phần cây còn lại');
    }
    const restImages = this.normalizeImages(dto.restImages);
    const blankImages = new Map(
      dto.blanks.map((line) => [
        line.intakeOrderId,
        this.normalizeImages(line.images),
      ]),
    );
    const slip = await tx.castingSlip.findUnique({
      where: { id },
      select: {
        slipDate: true,
        status: true,
        confirmedAt: true,
        castTreeWeightGram: true,
        orders: {
          select: {
            order: {
              select: {
                id: true,
                code: true,
                intakeCode: true,
                status: true,
                cutAt: true,
                qty: true,
                trackingCode: true,
                productName: true,
                description: true,
              },
            },
          },
        },
      },
    });
    if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
    if (slip.status !== CastingSlipStatus.DONE) {
      throw new BadRequestException('Chỉ cắt cây thông sau khi Đúc xong');
    }
    if (!slip.castTreeWeightGram || slip.castTreeWeightGram.lte(0)) {
      throw new BadRequestException('Chưa có trọng lượng cây thông sau đúc');
    }
    if (
      blanks.size !== slip.orders.length ||
      slip.orders.some(({ order }) => !blanks.has(order.id))
    ) {
      throw new BadRequestException(
        'Phải chia phôi cho đủ mọi đơn trên phiếu đúc',
      );
    }
    let allocated = restWeight;
    for (const { order } of slip.orders) {
      const blank = blanks.get(order.id)!;
      if (order.cutAt || order.status !== ProductionStatus.CAST_DONE) {
        throw new ConflictException(
          `Đơn ${order.intakeCode ?? order.code} chưa Đúc xong hoặc đã cắt cây thông`,
        );
      }
      if (blank.qty > order.qty) {
        throw new BadRequestException(
          `Phôi đơn ${order.intakeCode ?? order.code} vượt số lượng cần làm`,
        );
      }
      allocated = allocated.add(new Prisma.Decimal(blank.weightGram));
    }
    if (allocated.gt(slip.castTreeWeightGram)) {
      throw new BadRequestException(
        'Tổng phôi và phần cây còn lại vượt trọng lượng cây sau đúc',
      );
    }
    const claimed = await tx.castingSlip.updateMany({
      where: {
        id,
        status: CastingSlipStatus.DONE,
        restWeightGram: null,
      },
      data: {
        confirmedByName,
        restWeightGram: restWeight,
      },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException(
        'Phiếu đúc chưa Đúc xong hoặc đã cắt cây thông',
      );
    }
    const orderIds = slip.orders.map(({ order }) => order.id);
    const [btpWarehouse, pieceUnit, lastInbound] = await Promise.all([
      tx.warehouse.findUnique({
        where: { code: 'btp-cho-vao-da' },
        select: { id: true, code: true },
      }),
      tx.unit.findUnique({
        where: { code: 'chiec' },
        select: { id: true, name: true },
      }),
      tx.stockInbound.aggregate({
        where: { warehouse: { code: 'btp-cho-vao-da' } },
        _max: { sortOrder: true },
      }),
    ]);
    if (!btpWarehouse) throw new NotFoundException('Không tìm thấy kho BTP');
    if (!pieceUnit) {
      throw new BadRequestException('Thiếu đơn vị tính "chiec" để nhập phôi');
    }
    const inboundSort = { next: (lastInbound._max.sortOrder ?? 0) + 1 };
    const cutAt = new Date();
    // Cắt cây thông: đơn đã có sẵn từ lúc tạo — chỉ chuyển sang Nguội trên chính bản ghi đó,
    // không sinh đơn / phiếu mới.
    const moved = await tx.productionOrder.updateMany({
      where: {
        id: { in: orderIds },
        status: ProductionStatus.CAST_DONE,
        cutAt: null,
      },
      data: { status: ProductionStatus.WAIT_FILING },
    });
    if (moved.count !== orderIds.length) {
      throw new ConflictException('Một đơn trên phiếu vừa đổi trạng thái');
    }
    for (const { order } of slip.orders) {
      const blank = blanks.get(order.id)!;
      const cutImages = blankImages.get(order.id) ?? [];
      // Phôi cắt cho đơn ở phiếu đúc này — mốc hao hụt cắt.
      await tx.castingSlipOrder.update({
        where: { orderId: order.id },
        data: {
          blankQty: blank.qty,
          blankWeightGram: new Prisma.Decimal(blank.weightGram),
        },
      });
      const label = order.intakeCode ?? order.code;
      const name = order.productName?.trim();
      const description = [name, order.description]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(' — ');
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          castingSentDate: slip.slipDate,
          castingReturnedDate: cutAt,
          cutAt,
          blankQty: blank.qty,
          blankWeight: new Prisma.Decimal(blank.weightGram),
          dataChangedAt: cutAt,
          // Lệnh sản xuất hiển thị "tên SP — mô tả" như trước đây.
          ...(name && !order.description?.startsWith(name)
            ? { description }
            : {}),
          statusLogs: {
            create: {
              fromStatus: ProductionStatus.CAST_DONE,
              toStatus: ProductionStatus.WAIT_FILING,
              changedBy: confirmedByName,
              note: `Đúc xong, nhận ${blank.qty} phôi — cắt cây thông ${label}`,
            },
          },
          ...(cutImages.length
            ? {
                images: {
                  create: cutImages.map((image) => ({
                    ...image,
                    kind: 'CUT_BLANK' as const,
                  })),
                },
              }
            : {}),
        },
      });
      const materialId = await this.inventory.ensureNamedMaterial(tx, {
        warehouseCode: 'btp-cho-vao-da',
        name: `Phôi ${order.productName?.trim() || order.trackingCode?.trim() || order.code}`,
        unitCode: 'chiec',
        warehouse: btpWarehouse,
        unit: pieceUnit,
      });
      const inboundId = await this.inventory.createAutoInbound(tx, {
        materialId,
        qty: new Prisma.Decimal(blank.qty),
        gramQty: new Prisma.Decimal(blank.weightGram),
        receivedAt: cutAt,
        note: `Phôi đơn ${order.code} — đúc xong`,
        enteredBy: confirmedByName,
        productionOrderId: order.id,
        sortCursor: inboundSort,
      });
      await tx.productionOrder.update({
        where: { id: order.id },
        data: { blankMaterialId: materialId, blankInboundId: inboundId },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.ORDER_CUT, {
        orderCode: order.code,
        after: {
          status: ProductionStatus.WAIT_FILING,
          qty: blank.qty,
          weight: blank.weightGram,
          cutAt,
        },
        note: 'Cắt cây thông, cân phôi, chuyển sang Nguội',
      });
    }
    if (restWeight.gt(0)) {
      let restMaterialId = dto.restMaterialId;
      if (restMaterialId) {
        const material = await tx.material.findFirst({
          where: {
            id: restMaterialId,
            isActive: true,
            warehouse: { code: 'nvl-chinh' },
            unit: { code: 'gram' },
          },
          select: { id: true },
        });
        if (!material)
          throw new BadRequestException(
            'Mã NVL nhận phần còn lại không hợp lệ',
          );
      } else {
        restMaterialId = await this.inventory.ensureNamedMaterial(tx, {
          warehouseCode: 'nvl-chinh',
          name: REST_MATERIAL_NAME,
          unitCode: 'gram',
        });
      }
      const restInboundId = await this.inventory.createAutoInbound(tx, {
        materialId: restMaterialId,
        qty: restWeight,
        gramQty: restWeight,
        receivedAt: cutAt,
        note: 'Phần còn lại của cây sau đúc',
        enteredBy: confirmedByName,
      });
      await tx.castingSlip.update({
        where: { id },
        data: { restMaterialId, restInboundId },
      });
    }
    if (restImages.length) {
      await tx.castingSlipImage.createMany({
        data: restImages.map((image) => ({
          ...image,
          slipId: id,
          kind: CastingSlipImageKind.REST,
        })),
      });
    }
  }

  /** Mã NVL nhận phần cây còn lại sau đúc: kho NVL chính, tính theo gram. */
  async restMaterialOptions() {
    const rows = await this.prisma.material.findMany({
      where: {
        isActive: true,
        warehouse: { code: 'nvl-chinh' },
        unit: { code: 'gram' },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, sku: true, name: true },
    });
    return { defaultName: REST_MATERIAL_NAME, items: rows };
  }

  /**
   * Thủ kho báo lỗi đúc: đóng phiếu hiện tại, tạo phiếu mới (cùng đơn + vật tư đã cấp)
   * ở Chờ đúc để thợ làm lại và nhập kết quả mới.
   */
  async rejectCastResult(id: string, actor: AuthUserPayload) {
    if (!canConfirmIntakeWarehouse(actor)) {
      throw new ForbiddenException('Chỉ thủ kho được báo lỗi đúc');
    }
    const rejectedByName = actorName(actor);
    let redoId: string | null = null;
    await this.prisma.runTx(async (tx) => {
      const old = await tx.castingSlip.findUnique({
        where: { id },
        include: {
          orders: { orderBy: { sortOrder: 'asc' } },
          images: {
            where: { kind: CastingSlipImageKind.ISSUE },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
      if (!old) throw new NotFoundException('Không tìm thấy phiếu đúc');
      /** Phiếu làm lại luôn gắn phiếu gốc — kể cả khi báo lỗi trên phiếu con. */
      const rootSlipId = old.redoOfSlipId ?? old.id;
      const rootRow = await tx.castingSlip.findUnique({
        where: { id: rootSlipId },
        select: {
          slipDate: true,
          waxWeightGram: true,
          batchOrderCodes: true,
          estimateS999Gram: true,
          estimateMasterAlloyGram: true,
          estimateS925Gram: true,
          issueS999Gram: true,
          issueMasterAlloyGram: true,
          issueS925Gram: true,
          createdByName: true,
          startedByUserId: true,
          startedByName: true,
        },
      });
      if (!rootRow) {
        throw new NotFoundException('Không tìm thấy phiếu đúc gốc');
      }
      /** Thợ đúc: luôn giữ người giao ở phiếu cha gốc (lúc lên phiếu / bắt đầu đúc). */
      let castWorkerId =
        rootRow.startedByUserId ??
        (old.redoOfSlipId == null ? old.startedByUserId : null);
      let castWorkerName =
        rootRow.startedByName ??
        (old.redoOfSlipId == null ? old.startedByName : null);
      if (castWorkerId) {
        const assignee = await this.resolveCastWorker(castWorkerId);
        castWorkerId = assignee.id;
        castWorkerName = assignee.name;
      } else {
        throw new BadRequestException(
          'Phiếu gốc chưa giao thợ đúc — không tạo được phiếu làm lại',
        );
      }
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: CastingSlipStatus.PENDING_CONFIRMATION },
        data: {
          status: CastingSlipStatus.CAST_FAILED,
          rejectedAt: new Date(),
          rejectedByName,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Phiếu đúc chưa chờ thủ kho xác nhận');
      }
      const intakeIds = old.orders.map((line) => line.orderId);
      await tx.productionOrder.updateMany({
        where: {
          id: { in: intakeIds },
          status: ProductionStatus.CAST_PENDING_CONFIRMATION,
        },
        data: { status: ProductionStatus.WAIT_CASTING },
      });
      await tx.castingSlipOrder.deleteMany({ where: { slipId: id } });

      for (let attempt = 0; attempt < CODE_RETRIES; attempt++) {
        try {
          const created = await tx.castingSlip.create({
            data: {
              code: randomSlipCode(),
              slipDate: rootRow.slipDate,
              waxWeightGram: rootRow.waxWeightGram,
              batchOrderCodes: rootRow.batchOrderCodes,
              estimateS999Gram: rootRow.estimateS999Gram,
              estimateMasterAlloyGram: rootRow.estimateMasterAlloyGram,
              estimateS925Gram: rootRow.estimateS925Gram,
              issueS999Gram: rootRow.issueS999Gram,
              issueMasterAlloyGram: rootRow.issueMasterAlloyGram,
              issueS925Gram: rootRow.issueS925Gram,
              createdByName: rootRow.createdByName,
              startedByUserId: castWorkerId,
              startedByName: castWorkerName,
              status: CastingSlipStatus.WAIT_CASTING,
              redoOfSlipId: rootSlipId,
              orders: {
                create: old.orders.map((line) => ({
                  orderId: line.orderId,
                  sortOrder: line.sortOrder,
                  waxWeightGram: line.waxWeightGram,
                })),
              },
              images: {
                create: old.images.map((image) => ({
                  kind: CastingSlipImageKind.ISSUE,
                  url: image.url,
                  publicId: image.publicId,
                  width: image.width,
                  height: image.height,
                  sortOrder: image.sortOrder,
                })),
              },
            },
            select: { id: true },
          });
          redoId = created.id;
          break;
        } catch (error) {
          if (isUniqueViolation(error) && attempt < CODE_RETRIES - 1) {
            if (uniqueTarget(error).includes('order_id')) {
              throw new ConflictException(
                'Có đơn không gỡ được khỏi phiếu lỗi — tải lại và thử lại',
              );
            }
            continue;
          }
          throw error;
        }
      }
      if (!redoId) {
        throw new BadRequestException('Không tạo được phiếu làm lại, thử lại');
      }
    });
    return this.getById(redoId!);
  }

  private async buildListWhere(
    query: ListCastingSlipsQuery,
    opts?: { skipStatus?: boolean },
  ) {
    const and: Prisma.CastingSlipWhereInput[] = [];

    if (query.status && !opts?.skipStatus) and.push({ status: query.status });

    const search = query.search?.trim();
    if (search) {
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { batchOrderCodes: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const slipDate = query.slipDate?.trim();
    if (slipDate) {
      const day = parseOptionalDateOnly(slipDate);
      if (day) and.push({ slipDate: day });
    }

    const intakeCode = query.intakeCode?.trim();
    if (intakeCode) {
      and.push({
        orders: {
          some: {
            order: {
              intakeCode: { contains: intakeCode, mode: 'insensitive' },
            },
          },
        },
      });
    }

    const batchOrderCodes = query.batchOrderCodes?.trim();
    if (batchOrderCodes) {
      and.push({
        batchOrderCodes: { contains: batchOrderCodes, mode: 'insensitive' },
      });
    }

    const waxWeight = query.waxWeight?.trim();
    if (waxWeight) {
      const ids = await this.idsMatchingWaxWeightDigits(waxWeight);
      and.push({ id: { in: ids.length ? ids : [NO_MATCH_ID] } });
    }

    const issueTotal = query.issueTotal?.trim();
    if (issueTotal) {
      const ids = await this.idsMatchingIssueTotalDigits(issueTotal);
      and.push({ id: { in: ids.length ? ids : [NO_MATCH_ID] } });
    }

    if (query.awaitingCut) {
      and.push({
        OR: [awaitingCutWhere, { redos: { some: awaitingCutWhere } }],
      });
    }

    return and.length ? { AND: and } : {};
  }

  private async idsMatchingWaxWeightDigits(term: string) {
    const digits = digitsOnly(term);
    if (!digits) return [];
    const pattern = `%${digits}%`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM casting_slips
      WHERE regexp_replace(wax_weight_gram::text, '[^0-9]', '', 'g') LIKE ${pattern}
    `;
    return rows.map((row) => row.id);
  }

  private async idsMatchingIssueTotalDigits(term: string) {
    const digits = digitsOnly(term);
    if (!digits) return [];
    const pattern = `%${digits}%`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM casting_slips
      WHERE regexp_replace(
        (
          COALESCE(issue_s999_gram, 0)
          + COALESCE(issue_master_alloy_gram, 0)
          + COALESCE(issue_s925_gram, 0)
        )::text,
        '[^0-9]',
        '',
        'g'
      ) LIKE ${pattern}
    `;
    return rows.map((row) => row.id);
  }

  private normalizeImages(images: CastingSlipImageDto[]) {
    const seen = new Set<string>();
    return images
      .filter((image) => {
        if (seen.has(image.publicId)) return false;
        seen.add(image.publicId);
        return true;
      })
      .map((image, sortOrder) => {
        const host = new URL(image.url).hostname;
        if (
          host !== 'res.cloudinary.com' ||
          !this.cloudinary.ownsPublicId(image.publicId)
        ) {
          throw new BadRequestException('Ảnh không thuộc kho ảnh của hệ thống');
        }
        return {
          url: image.url,
          publicId: image.publicId,
          width: image.width ?? null,
          height: image.height ?? null,
          sortOrder,
        };
      });
  }
}

/** Phiếu Đúc xong còn cắt được: đơn vẫn CAST_DONE, chưa cắt cây (`cutAt` rỗng). */
const awaitingCutWhere: Prisma.CastingSlipWhereInput = {
  status: CastingSlipStatus.DONE,
  restWeightGram: null,
  castTreeWeightGram: { gt: 0 },
  orders: {
    some: {},
    every: {
      blankQty: null,
      blankWeightGram: null,
      order: {
        status: ProductionStatus.CAST_DONE,
        cutAt: null,
      },
    },
  },
};

const slipOrderSelect = {
  id: true,
  code: true,
  intakeCode: true,
  sxCode: true,
  productName: true,
  trackingCode: true,
  qty: true,
  status: true,
  cutAt: true,
} as const;

const slipOrderListInclude = {
  orders: {
    orderBy: { sortOrder: 'asc' as const },
    include: { order: { select: slipOrderSelect } },
  },
} as const;

const slipOrderDetailInclude = {
  orders: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      order: {
        select: {
          ...slipOrderSelect,
          images: {
            where: { kind: ProductionImageKind.CUT_BLANK },
            orderBy: { sortOrder: 'asc' as const },
            select: { url: true, publicId: true, width: true, height: true },
          },
        },
      },
    },
  },
} as const;

const slipInclude = {
  ...slipOrderDetailInclude,
  images: { orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.CastingSlipInclude;

/** Danh sách: không kéo ảnh phiếu / ảnh phôi — chỉ tải khi mở chi tiết. */
const slipListInclude = {
  ...slipOrderListInclude,
  redos: {
    orderBy: { createdAt: 'asc' as const },
    include: slipOrderListInclude,
  },
} satisfies Prisma.CastingSlipInclude;

type SlipRow = Prisma.CastingSlipGetPayload<{ include: typeof slipInclude }>;
type SlipListRow = Prisma.CastingSlipGetPayload<{
  include: typeof slipListInclude;
}>;
type SlipRowBaseInput = SlipRow | SlipListRow | SlipListRow['redos'][number];

function slipImagesOf(row: SlipRowBaseInput) {
  return 'images' in row && Array.isArray(row.images) ? row.images : [];
}

/**
 * TL sáp (cây thông) giao, "lấy từ trạng thái E": số thủ kho cân kiểm nếu có, không thì
 * cây thông thợ sáp cân (in resin), cuối cùng là TL sáp bơm (có khuôn).
 */
function waxWeightOf(order: {
  waxCheckedWeightGram: Prisma.Decimal | null;
  castingTreeWeightGram: Prisma.Decimal | null;
  productWeightGram: Prisma.Decimal | null;
}) {
  return (
    order.waxCheckedWeightGram ??
    order.castingTreeWeightGram ??
    order.productWeightGram
  );
}

function dec(value: Prisma.Decimal | null | undefined) {
  return value != null ? value.toString() : null;
}

function blankWeightTotal(
  orders: Array<{ blankWeightGram: Prisma.Decimal | null }>,
) {
  return orders.reduce(
    (sum, line) => sum.add(line.blankWeightGram ?? 0),
    new Prisma.Decimal(0),
  );
}

/** 1 g sáp = 24 g bạc — ước tính S999 / Hội / S925. */
const WAX_TO_SILVER = 24;

function silverEstimateFromWax(wax: Prisma.Decimal) {
  return wax.mul(WAX_TO_SILVER);
}

function optionalIssued(value?: number) {
  return value != null && value > 0 ? new Prisma.Decimal(value) : null;
}

/** Không nhập thực xuất lúc xác nhận cấp vật tư → lấy đúng số ước tính (sáp × 24). */
function resolveIssuedGrams(
  slip: {
    waxWeightGram: Prisma.Decimal;
    estimateS999Gram: Prisma.Decimal | null;
    estimateMasterAlloyGram: Prisma.Decimal | null;
    estimateS925Gram: Prisma.Decimal | null;
  },
  dto: {
    issueS999Gram?: number;
    issueMasterAlloyGram?: number;
    issueS925Gram?: number;
  },
) {
  const entered = {
    issueS999Gram: optionalIssued(dto.issueS999Gram),
    issueMasterAlloyGram: optionalIssued(dto.issueMasterAlloyGram),
    issueS925Gram: optionalIssued(dto.issueS925Gram),
  };
  const enteredTotal =
    Number(entered.issueS999Gram ?? 0) +
    Number(entered.issueMasterAlloyGram ?? 0) +
    Number(entered.issueS925Gram ?? 0);
  if (enteredTotal > 0) return entered;
  const fallback =
    slip.estimateS999Gram ?? silverEstimateFromWax(slip.waxWeightGram);
  return {
    issueS999Gram: slip.estimateS999Gram ?? fallback,
    issueMasterAlloyGram: slip.estimateMasterAlloyGram ?? fallback,
    issueS925Gram: slip.estimateS925Gram ?? fallback,
  };
}

function issueTotal(row: {
  issueS999Gram: Prisma.Decimal | null;
  issueMasterAlloyGram: Prisma.Decimal | null;
  issueS925Gram: Prisma.Decimal | null;
}) {
  const parts = [row.issueS999Gram, row.issueMasterAlloyGram, row.issueS925Gram]
    .filter((part): part is Prisma.Decimal => part != null)
    .map((part) => Number(part.toString()));
  if (parts.length === 3 && parts[0] === parts[1] && parts[1] === parts[2]) {
    // Ba cột cùng số ước tính (sáp × 24) — tổng thực xuất là số đó, không nhân 3.
    return String(parts[0]);
  }
  return String(parts.reduce((sum, n) => sum + n, 0));
}

/**
 * Hao hụt một lần đúc: trả = cây thông + bạc giao chưa dùng; hao hụt = bạc đã dùng − cây thông.
 * Chưa nhập kết quả thì các số là null.
 */
function castLossOf(row: {
  issueS999Gram: Prisma.Decimal | null;
  issueMasterAlloyGram: Prisma.Decimal | null;
  issueS925Gram: Prisma.Decimal | null;
  silverUsedGram: Prisma.Decimal | null;
  castTreeWeightGram: Prisma.Decimal | null;
}) {
  if (row.silverUsedGram == null || row.castTreeWeightGram == null) {
    return {
      leftoverGram: null,
      returnTotalGram: null,
      castLossGram: null,
      castLossPercent: null,
    };
  }
  const issued = new Prisma.Decimal(issueTotal(row));
  const leftover = issued.gt(row.silverUsedGram)
    ? issued.sub(row.silverUsedGram)
    : new Prisma.Decimal(0);
  const loss = row.silverUsedGram.sub(row.castTreeWeightGram);
  return {
    leftoverGram: leftover.toString(),
    returnTotalGram: row.castTreeWeightGram.add(leftover).toString(),
    castLossGram: loss.toString(),
    castLossPercent: row.silverUsedGram.gt(0)
      ? loss.div(row.silverUsedGram).mul(100).toDecimalPlaces(2).toString()
      : null,
  };
}

function toImage(image: {
  url: string;
  publicId: string;
  width: number | null;
  height: number | null;
}) {
  return {
    url: image.url,
    publicId: image.publicId,
    width: image.width,
    height: image.height,
  };
}

function slipRowBase(row: SlipRowBaseInput) {
  const images = slipImagesOf(row);
  return {
    id: row.id,
    code: row.code,
    slipDate: row.slipDate.toISOString().slice(0, 10),
    waxWeightGram: row.waxWeightGram.toString(),
    batchOrderCodes: row.batchOrderCodes,
    orders: row.orders.map((line) => ({
      intakeOrderId: line.orderId,
      code: line.order.intakeCode ?? line.order.code,
      sxCode: line.order.sxCode ?? line.order.code,
      productName: line.order.productName,
      trackingCode: line.order.trackingCode,
      qty: line.order.qty,
      status: toIntakeStatus(line.order),
      /** Trạng thái thật trên lệnh SX — sau cắt cây đi từ Chờ nguội theo lộ trình. */
      orderStatus: line.order.status,
      // Cùng một bản ghi: mã A… có từ lúc tạo, "đã vào lệnh sản xuất" = đã cắt cây.
      productionOrderCode: line.order.cutAt ? line.order.code : null,
      blankQty: line.blankQty,
      blankWeightGram: dec(line.blankWeightGram),
      blankImages:
        'images' in line.order && Array.isArray(line.order.images)
          ? line.order.images.map(toImage)
          : [],
      waxWeightGram: line.waxWeightGram.toString(),
    })),
    estimateS999Gram: dec(silverEstimateFromWax(row.waxWeightGram)),
    estimateMasterAlloyGram: dec(silverEstimateFromWax(row.waxWeightGram)),
    estimateS925Gram: dec(silverEstimateFromWax(row.waxWeightGram)),
    estimateTotalGram: silverEstimateFromWax(row.waxWeightGram).toString(),
    issueS999Gram: dec(row.issueS999Gram),
    issueMasterAlloyGram: dec(row.issueMasterAlloyGram),
    issueS925Gram: dec(row.issueS925Gram),
    issueTotalGram: issueTotal(row),
    createdByName: row.createdByName,
    ...castLossOf(row),
    lastPrintedAt: row.lastPrintedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    startedByName: row.startedByName,
    castTreeWeightGram: dec(row.castTreeWeightGram),
    silverUsedGram: dec(row.silverUsedGram),
    plasterUsedGram: dec(row.plasterUsedGram),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    submittedByName: row.submittedByName,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmedByName: row.confirmedByName,
    restWeightGram: dec(row.restWeightGram),
    // Hao hụt cắt = cây sau đúc − phôi các đơn (ghi theo phiếu lúc cắt) − phần còn lại về NVL.
    cutLossGram:
      row.restWeightGram != null && row.castTreeWeightGram != null
        ? row.castTreeWeightGram
            .sub(row.restWeightGram)
            .sub(blankWeightTotal(row.orders))
            .toString()
        : null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectedByName: row.rejectedByName,
    redoOfSlipId: row.redoOfSlipId,
    images: images
      .filter((image) => image.kind === CastingSlipImageKind.ISSUE)
      .map(toImage),
    resultImages: images
      .filter((image) => image.kind === CastingSlipImageKind.RESULT)
      .map(toImage),
    restImages: images
      .filter((image) => image.kind === CastingSlipImageKind.REST)
      .map(toImage),
  };
}

type CastingSlipRowDto = ReturnType<typeof slipRowBase> & {
  redos: CastingSlipRowDto[];
};

function toRow(row: SlipRow | SlipListRow): CastingSlipRowDto {
  const redos = 'redos' in row ? row.redos : [];
  return {
    ...slipRowBase(row),
    redos: redos.map((child) => ({ ...slipRowBase(child), redos: [] })),
  };
}

/** Cột vi phạm unique của lỗi Prisma P2002 (`meta.target` là tên cột / mảng cột / tên index). */
function uniqueTarget(error: unknown): string {
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
  if (Array.isArray(target)) return target.map(String).join(',');
  return typeof target === 'string' ? target : '';
}
