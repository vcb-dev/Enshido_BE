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
  IntakeOrderStatus,
  Prisma,
  ProductionSource,
  ProductionStatus,
} from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { canConfirmIntakeWarehouse } from '../intake-orders/intake-warehouse-access';
import { InventoryService } from '../inventory/inventory.service';
import { dbTable } from '../prisma/database-url';
import { PrismaService } from '../prisma/prisma.service';
import { decStr } from '../util/money';
import { actorName } from '../production-orders/order-detail';
import { ACTIVITY, logActivity } from '../production-orders/activity-log';
import { orderCode } from '../production-orders/production-orders.service';
import { CloudinaryService } from '../uploads/cloudinary.service';
import {
  CastingLossQuery,
  ConfirmCastingSlipDto,
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
    const where = await this.buildListWhere(query);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.castingSlip.count({ where }),
      this.prisma.castingSlip.findMany({
        where,
        orderBy: [{ slipDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: slipInclude,
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
    const rows = await this.prisma.intakeOrder.findMany({
      where: {
        status: IntakeOrderStatus.WAX_CONFIRMED,
        castingSlipLine: null,
        ...(keyword
          ? {
              OR: [
                { code: contains },
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
      code: row.code,
      sxCode: row.sxCode,
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
    const issued =
      (dto.issueS999Gram ?? 0) +
      (dto.issueMasterAlloyGram ?? 0) +
      (dto.issueS925Gram ?? 0);
    // Bước 9 so TL cây sau đúc và bạc đã dùng với số giao, nên phiếu phải ghi vật tư giao.
    if (!(issued > 0)) {
      throw new BadRequestException('Nhập số gram bạc / hội / S925 cấp cho lần đúc');
    }
    const slipDate = parseDate(dto.slipDate, 'Ngày phiếu');
    const orders = await this.prisma.intakeOrder.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
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
      if (order.castingSlipLine) {
        throw new BadRequestException(`Đơn ${order.code} đã nằm trên phiếu đúc khác`);
      }
      if (order.status !== IntakeOrderStatus.WAX_CONFIRMED) {
        throw new BadRequestException(
          `Đơn ${order.code} chưa ở trạng thái Chờ SX · Đã có Sáp (E)`,
        );
      }
      const wax = waxWeightOf(order);
      if (wax == null || wax.lte(0)) {
        throw new BadRequestException(`Đơn ${order.code} thiếu trọng lượng sáp / cây thông`);
      }
      return { intakeOrderId: id, sortOrder, waxWeightGram: wax, code: order.code };
    });
    const waxWeightGram = lines.reduce(
      (sum, line) => sum.add(line.waxWeightGram),
      new Prisma.Decimal(0),
    );
    const createdByName = actorName(actor);

    for (let attempt = 0; attempt < CODE_RETRIES; attempt++) {
      try {
        const slip = await this.prisma.runTx(async (tx) => {
          const row = await tx.castingSlip.create({
            data: {
              code: randomSlipCode(),
              slipDate,
              waxWeightGram,
              batchOrderCodes: lines.map((line) => line.code).join(', '),
              issueS999Gram: dto.issueS999Gram ?? null,
              issueMasterAlloyGram: dto.issueMasterAlloyGram ?? null,
              issueS925Gram: dto.issueS925Gram ?? null,
              createdByName,
              status: CastingSlipStatus.PENDING_ISSUE,
              orders: {
                create: lines.map(({ intakeOrderId, sortOrder, waxWeightGram: wax }) => ({
                  intakeOrderId,
                  sortOrder,
                  waxWeightGram: wax,
                })),
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
          const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
          if (String(target ?? '').includes('intake_order_id')) {
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
        select: { orders: { select: { intakeOrderId: true } } },
      });
      if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: CastingSlipStatus.PENDING_ISSUE },
        data: { status: CastingSlipStatus.WAIT_CASTING },
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
      const ids = slip.orders.map((line) => line.intakeOrderId);
      const moved = await tx.intakeOrder.updateMany({
        where: { id: { in: ids }, status: IntakeOrderStatus.WAX_CONFIRMED },
        data: { status: IntakeOrderStatus.WAIT_CASTING },
      });
      if (moved.count !== ids.length) {
        throw new ConflictException('Có đơn trên phiếu không còn ở Chờ SX · Đã có sáp');
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
          ? { confirmedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
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
      { name: string; slips: number; issued: Prisma.Decimal; used: Prisma.Decimal; tree: Prisma.Decimal }
    >();
    for (const row of rows) {
      if (row.silverUsedGram == null || row.castTreeWeightGram == null) continue;
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
        lossPercent: acc.used.gt(0) ? loss.div(acc.used).mul(100).toDecimalPlaces(2).toString() : null,
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

  /** Bước 8: thợ đúc quét phiếu + nguyên liệu, xác nhận bắt đầu đúc (F → G). */
  async start(id: string, actor: AuthUserPayload) {
    const startedByName = actorName(actor);
    await this.prisma.runTx(async (tx) => {
      const slip = await tx.castingSlip.findUnique({
        where: { id },
        select: { orders: { select: { intakeOrderId: true } } },
      });
      if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: CastingSlipStatus.WAIT_CASTING },
        data: {
          status: CastingSlipStatus.CASTING,
          startedAt: new Date(),
          startedByName,
          startedByUserId: actor.id,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Phiếu đúc không ở trạng thái Chờ đúc');
      }
      await tx.intakeOrder.updateMany({
        where: {
          id: { in: slip.orders.map((line) => line.intakeOrderId) },
          status: IntakeOrderStatus.WAIT_CASTING,
        },
        data: { status: IntakeOrderStatus.CASTING },
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

  /** Xác nhận đúc, nhập phôi theo từng lệnh và cho toàn bộ lô vào Nguội trong một giao dịch. */
  async confirm(id: string, dto: ConfirmCastingSlipDto, actor: AuthUserPayload) {
    if (!canConfirmIntakeWarehouse(actor)) {
      throw new ForbiddenException('Chỉ thủ kho được xác nhận Đúc xong');
    }
    const confirmedByName = actorName(actor);
    const restWeight = new Prisma.Decimal(dto.restWeightGram);
    const blanks = new Map(dto.blanks.map((line) => [line.intakeOrderId, line]));
    if (blanks.size !== dto.blanks.length) {
      throw new BadRequestException('Mỗi đơn chỉ được chia phôi một lần');
    }
    if (restWeight.gt(0) && !dto.restImages.length) {
      throw new BadRequestException('Chụp ảnh cân phần cây còn lại');
    }
    const restImages = this.normalizeImages(dto.restImages);
    const blankImages = new Map(
      dto.blanks.map((line) => [line.intakeOrderId, this.normalizeImages(line.images)]),
    );
    await this.prisma.runTx(async (tx) => {
      const slip = await tx.castingSlip.findUnique({
        where: { id },
        select: {
          slipDate: true,
          status: true,
          confirmedAt: true,
          castTreeWeightGram: true,
          orders: {
            select: {
              intake: {
                select: {
                  id: true, code: true, status: true, requestType: true,
                  productName: true, qty: true, trackingCode: true, placedBy: true,
                  description: true, createdDate: true, dueDate: true, model3dUrl: true,
                  stoneCount3d: true, stoneWeight3dGram: true,
                  reworkOfOrderId: true, reworkOfSubTicketId: true,
                  productionOrder: { select: { id: true } },
                },
              },
            },
          },
        },
      });
      if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
      if (!slip.castTreeWeightGram || slip.castTreeWeightGram.lte(0)) {
        throw new BadRequestException('Chưa có trọng lượng cây thông sau đúc');
      }
      if (blanks.size !== slip.orders.length ||
        slip.orders.some(({ intake }) => !blanks.has(intake.id))) {
        throw new BadRequestException('Phải chia phôi cho đủ mọi đơn trên phiếu đúc');
      }
      let allocated = restWeight;
      for (const { intake } of slip.orders) {
        const blank = blanks.get(intake.id)!;
        if (intake.productionOrder || (intake.status !== IntakeOrderStatus.CASTING && intake.status !== IntakeOrderStatus.WAIT_CASTING && intake.status !== IntakeOrderStatus.CAST_DONE)) {
          throw new ConflictException(`Đơn ${intake.code} đã chuyển bước, tải lại phiếu đúc`);
        }
        if (blank.qty > intake.qty) {
          throw new BadRequestException(`Phôi đơn ${intake.code} vượt số lượng cần làm`);
        }
        allocated = allocated.add(new Prisma.Decimal(blank.weightGram));
      }
      if (allocated.gt(slip.castTreeWeightGram)) {
        throw new BadRequestException('Tổng phôi và phần cây còn lại vượt trọng lượng cây sau đúc');
      }
      const claimed = await tx.castingSlip.updateMany({
        where: { id, status: { in: [CastingSlipStatus.PENDING_CONFIRMATION, CastingSlipStatus.DONE] } },
        data: {
          status: CastingSlipStatus.DONE,
          confirmedAt: slip.confirmedAt ?? new Date(),
          confirmedByName,
          restWeightGram: restWeight,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Phiếu đúc chưa chờ thủ kho xác nhận');
      }
      // Keep the sequence lock transaction-scoped, but return a Prisma-decodable
      // value instead of PostgreSQL's `void` lock-function result.
      await tx.$queryRaw`
        WITH sequence_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtext('enshido_production_order_seq'))
        )
        SELECT 1::int AS locked FROM sequence_lock
      `;
      const last = await tx.productionOrder.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });
      let seq = last?.seq ?? 0;
      const cutAt = new Date();
      for (const { intake } of slip.orders) {
        const blank = blanks.get(intake.id)!;
        const moved = await tx.intakeOrder.updateMany({
          where: { id: intake.id, status: { in: [IntakeOrderStatus.CASTING, IntakeOrderStatus.WAIT_CASTING, IntakeOrderStatus.CAST_DONE] } },
          data: { status: IntakeOrderStatus.WAIT_COOLING },
        });
        if (moved.count !== 1) throw new ConflictException(`Đơn ${intake.code} vừa đổi trạng thái`);
        // Đơn bù cho hàng lỗi: không sinh đơn A mới, thành phiếu con mới của đơn gốc.
        if (intake.reworkOfOrderId) {
          await this.attachReworkTicket(tx, intake, blank, cutAt, confirmedByName, actor);
          continue;
        }
        seq += 1;
        const code = orderCode(seq);
        const order = await tx.productionOrder.create({
          data: {
            seq, code, status: ProductionStatus.WAIT_FILING, source: ProductionSource.NVL,
            requestType: intake.requestType, qty: intake.qty, trackingCode: intake.trackingCode,
            model3dCode: intake.trackingCode, model3dUrl: intake.model3dUrl,
            closedBy: intake.placedBy,
            description: [intake.productName, intake.description].map((part) => part.trim()).filter(Boolean).join(' — '),
            receivedDate: intake.createdDate, dueDate: intake.dueDate,
            castingSentDate: slip.slipDate, castingReturnedDate: cutAt, cutAt,
            blankQty: blank.qty, blankWeight: new Prisma.Decimal(blank.weightGram),
            createdBy: confirmedByName, createdByUserId: actor.id, intakeOrderId: intake.id,
            // Mặc định 1 đơn là 1 phiếu (bước 11): thủ kho chia nhỏ sau nếu cần.
            // Đá theo 3D khai ở bước 3D / bơm sáp: mốc hao hụt Vào đá; 0 viên = bỏ qua Vào đá.
            stoneCount: intake.stoneCount3d, stoneWeight: intake.stoneWeight3dGram,
            subTicketSeq: 1,
            subTickets: { create: { no: 1, qty: intake.qty, createdByUserId: actor.id, createdByName: confirmedByName } },
            statusLogs: { create: { toStatus: ProductionStatus.WAIT_FILING, changedBy: confirmedByName,
              note: `Đúc xong, nhận ${blank.qty} phôi từ đơn tạo ${intake.code}` } },
            images: { create: blankImages.get(intake.id)!.map((image) => ({ ...image, kind: 'CUT_BLANK' as const })) },
          },
          select: { id: true },
        });
        const materialId = await this.inventory.ensureNamedMaterial(tx, {
          warehouseCode: 'btp-cho-vao-da', name: `Phôi ${intake.trackingCode?.trim() || code}`, unitCode: 'chiec',
        });
        const inboundId = await this.inventory.createAutoInbound(tx, {
          materialId, qty: new Prisma.Decimal(blank.qty), gramQty: new Prisma.Decimal(blank.weightGram),
          receivedAt: cutAt, note: `Phôi đơn ${code} — đúc xong`, enteredBy: confirmedByName,
          productionOrderId: order.id,
        });
        await tx.productionOrder.update({ where: { id: order.id }, data: { blankMaterialId: materialId, blankInboundId: inboundId } });
        await logActivity(tx, order.id, actor, ACTIVITY.ORDER_CUT, {
          orderCode: code, after: { status: ProductionStatus.WAIT_FILING, qty: blank.qty, weight: blank.weightGram, cutAt },
          note: 'Cân phôi sau đúc, chuyển sang Nguội',
        });
      }
      if (restWeight.gt(0)) {
        let restMaterialId = dto.restMaterialId;
        if (restMaterialId) {
          const material = await tx.material.findFirst({ where: { id: restMaterialId, isActive: true,
            warehouse: { code: 'nvl-chinh' }, unit: { code: 'gram' } }, select: { id: true } });
          if (!material) throw new BadRequestException('Mã NVL nhận phần còn lại không hợp lệ');
        } else {
          restMaterialId = await this.inventory.ensureNamedMaterial(tx, {
            warehouseCode: 'nvl-chinh', name: REST_MATERIAL_NAME, unitCode: 'gram',
          });
        }
        const restInboundId = await this.inventory.createAutoInbound(tx, {
          materialId: restMaterialId, qty: restWeight, gramQty: restWeight, receivedAt: cutAt,
          note: 'Phần còn lại của cây sau đúc', enteredBy: confirmedByName,
        });
        await tx.castingSlip.update({ where: { id }, data: { restMaterialId, restInboundId } });
        await tx.castingSlipImage.createMany({ data: restImages.map((image) => ({ ...image, slipId: id, kind: CastingSlipImageKind.REST })) });
      }
    });
    this.inventory.bustBtpStock();
    this.inventory.bustNvlStock();
    return this.getById(id);
  }

  /**
   * Đúc xong đơn bù (hàng lỗi Nguội / Vào đá): cộng phôi vào đơn gốc và tạo phiếu con mới ở
   * trạng thái Chờ nguội — thủ kho chỉ định thợ Nguội như phiếu thường.
   */
  private async attachReworkTicket(
    tx: Prisma.TransactionClient,
    intake: { id: string; code: string; qty: number; trackingCode: string | null; reworkOfOrderId: string | null; reworkOfSubTicketId: string | null },
    blank: { qty: number; weightGram: number | string | Prisma.Decimal },
    cutAt: Date,
    by: string,
    actor: AuthUserPayload,
  ) {
    const orderId = intake.reworkOfOrderId!;
    await tx.$queryRaw`SELECT id FROM ${dbTable('production_orders')} WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.productionOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true, code: true, status: true, blankMaterialId: true, blankQty: true,
        blankWeight: true, subTicketSeq: true,
        subTickets: { select: { id: true, no: true } },
      },
    });
    if (order.status === ProductionStatus.DELIVERED) {
      throw new BadRequestException(`Đơn gốc ${order.code} đã giao — không nhận thêm phiếu bù ${intake.code}`);
    }
    const weight = new Prisma.Decimal(blank.weightGram);
    const materialId =
      order.blankMaterialId ??
      (await this.inventory.ensureNamedMaterial(tx, {
        warehouseCode: 'btp-cho-vao-da', name: `Phôi ${intake.trackingCode?.trim() || order.code}`, unitCode: 'chiec',
      }));
    const inboundId = await this.inventory.createAutoInbound(tx, {
      materialId, qty: new Prisma.Decimal(blank.qty), gramQty: weight,
      receivedAt: cutAt, note: `Phôi bù ${intake.code} — đúc xong, cho đơn ${order.code}`,
      enteredBy: by, productionOrderId: order.id,
    });
    const no = order.subTicketSeq + 1;
    const origin = order.subTickets.find((ticket) => ticket.id === intake.reworkOfSubTicketId);
    const from = origin ? `${order.code}-${origin.no}` : order.code;
    await tx.productionSubTicket.create({
      data: {
        orderId: order.id, no, qty: intake.qty,
        note: `Bù cho ${from} (${intake.code})`,
        createdByUserId: actor.id, createdByName: by,
      },
    });
    const reopen =
      order.status === ProductionStatus.DEFECT || order.status === ProductionStatus.FINISHING;
    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        blankMaterialId: materialId,
        blankInboundId: order.blankMaterialId ? undefined : inboundId,
        blankQty: (order.blankQty ?? 0) + blank.qty,
        blankWeight: (order.blankWeight ?? new Prisma.Decimal(0)).add(weight),
        subTicketSeq: no,
        dataChangedAt: new Date(),
        ...(reopen
          ? {
              status: ProductionStatus.WAIT_FILING,
              statusLogs: { create: { fromStatus: order.status, toStatus: ProductionStatus.WAIT_FILING, changedBy: by,
                note: `Phiếu bù ${order.code}-${no} (${intake.qty} sp) đúc xong — quay lại Nguội` } },
            }
          : {}),
      },
    });
    await logActivity(tx, order.id, actor, ACTIVITY.ORDER_CUT, {
      orderCode: order.code, subTicketNo: no,
      after: { reworkIntake: intake.code, qty: intake.qty, weight: decStr(weight) },
      note: `Đúc xong phiếu bù ${intake.code}, tạo phiếu con ${order.code}-${no}`,
    });
  }

  /** Mã NVL nhận phần cây còn lại sau đúc: kho NVL chính, tính theo gram. */
  async restMaterialOptions() {
    const rows = await this.prisma.material.findMany({
      where: { isActive: true, warehouse: { code: 'nvl-chinh' }, unit: { code: 'gram' } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, sku: true, name: true },
    });
    return { defaultName: REST_MATERIAL_NAME, items: rows };
  }

  private async buildListWhere(query: ListCastingSlipsQuery) {
    const and: Prisma.CastingSlipWhereInput[] = [];

    if (query.status) and.push({ status: query.status });

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
          some: { intake: { code: { contains: intakeCode, mode: 'insensitive' } } },
        },
      });
    }

    const batchOrderCodes = query.batchOrderCodes?.trim();
    if (batchOrderCodes) {
      and.push({ batchOrderCodes: { contains: batchOrderCodes, mode: 'insensitive' } });
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

const slipInclude = {
  orders: {
    orderBy: { sortOrder: 'asc' },
    include: {
      intake: {
        select: {
          id: true,
          code: true,
          sxCode: true,
          productName: true,
          trackingCode: true,
          qty: true,
          status: true,
          productionOrder: { select: { code: true, blankWeight: true } },
        },
      },
    },
  },
  images: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.CastingSlipInclude;

type SlipRow = Prisma.CastingSlipGetPayload<{ include: typeof slipInclude }>;

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

function issueTotal(row: {
  issueS999Gram: Prisma.Decimal | null;
  issueMasterAlloyGram: Prisma.Decimal | null;
  issueS925Gram: Prisma.Decimal | null;
}) {
  let sum = 0;
  for (const part of [row.issueS999Gram, row.issueMasterAlloyGram, row.issueS925Gram]) {
    if (part != null) sum += Number(part.toString());
  }
  return String(sum);
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
    return { leftoverGram: null, returnTotalGram: null, castLossGram: null, castLossPercent: null };
  }
  const issued = new Prisma.Decimal(issueTotal(row));
  const leftover = issued.gt(row.silverUsedGram) ? issued.sub(row.silverUsedGram) : new Prisma.Decimal(0);
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

function toRow(row: SlipRow) {
  return {
    id: row.id,
    code: row.code,
    slipDate: row.slipDate.toISOString().slice(0, 10),
    waxWeightGram: row.waxWeightGram.toString(),
    batchOrderCodes: row.batchOrderCodes,
    orders: row.orders.map((line) => ({
      intakeOrderId: line.intakeOrderId,
      code: line.intake.code,
      sxCode: line.intake.sxCode,
      productName: line.intake.productName,
      trackingCode: line.intake.trackingCode,
      qty: line.intake.qty,
      status: line.intake.status,
      productionOrderCode: line.intake.productionOrder?.code ?? null,
      waxWeightGram: line.waxWeightGram.toString(),
    })),
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
    cutLossGram: row.restWeightGram != null && row.castTreeWeightGram != null
      ? row.castTreeWeightGram.sub(row.restWeightGram).sub(
          row.orders.reduce((sum, line) => sum.add(line.intake.productionOrder?.blankWeight ?? 0), new Prisma.Decimal(0)),
        ).toString()
      : null,
    images: row.images
      .filter((image) => image.kind === CastingSlipImageKind.ISSUE)
      .map(toImage),
    resultImages: row.images
      .filter((image) => image.kind === CastingSlipImageKind.RESULT)
      .map(toImage),
    restImages: row.images
      .filter((image) => image.kind === CastingSlipImageKind.REST)
      .map(toImage),
  };
}
