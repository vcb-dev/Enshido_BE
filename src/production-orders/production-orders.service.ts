import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProductionSource,
  ProductionStatus,
  RoleCode,
} from '@prisma/client';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../uploads/cloudinary.service';
import { decStr } from '../util/money';
import {
  CastingDto,
  ChangeStatusDto,
  FinishOrderDto,
  HandoverStageDto,
  ListProductionOrdersQuery,
  OrderCostDto,
  OrderImageDto,
  ReturnStageDto,
  StageLaborDto,
  StartStageDto,
  UpsertProductionOrderDto,
} from './dto/production-order.dto';
import {
  actorName,
  decimalOrNull,
  detailInclude,
  entriesOf,
  IN_STAGE_STATUSES,
  normalizeCode,
  type OrderDetail,
  requireStage,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_STATUS,
  type StageEntry,
  STATUS_LABEL,
  subTicketCode,
  subTicketState,
  toDetail,
  ymd,
} from './order-detail';

const S = ProductionStatus;

/**
 * Đổi tay được. Đúc đi qua báo Đúc, các khâu đi qua giao thợ, Đã giao đến từ phiếu xuất
 * hàng — để phiếu thợ, kho thành phẩm và hệ thống luôn khớp.
 */
const MANUAL_STATUSES: ProductionStatus[] = [S.NEW, S.REDO_3D, S.DEFECT];

const DEFAULT_LEAD_TIMES = ['3-5 ngày', '7-15 ngày', '15-30 ngày'];

const SUGGEST_COLUMNS = {
  closedBy: 'closed_by',
  leadTime: 'lead_time',
  debtStatus: 'debt_status',
} as const;

const CREATE_RETRIES = 3;

const BTP_WAREHOUSE_CODE = 'btp-cho-vao-da';

@Injectable()
export class ProductionOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly inventory: InventoryService,
  ) {}

  async list(query: ListProductionOrdersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const dir = query.dir ?? 'desc';
    const sort = query.sort ?? 'code';

    const base: Prisma.ProductionOrderWhereInput = {};
    if (query.requestType) base.requestType = query.requestType;
    if (query.source) base.source = query.source;
    const search = query.search?.trim();
    if (search) {
      const contains = { contains: search, mode: 'insensitive' as const };
      base.OR = [
        { code: contains },
        { trackingCode: contains },
        { model3dCode: contains },
        { closedBy: contains },
        { description: contains },
      ];
    }
    const where = query.status ? { ...base, status: query.status } : base;
    const orderBy: Prisma.ProductionOrderOrderByWithRelationInput[] =
      sort === 'code' ? [{ seq: dir }] : [{ [sort]: dir }, { seq: 'desc' }];

    const [rows, total, grouped] = await Promise.all([
      this.prisma.productionOrder.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          images: {
            select: { id: true, kind: true, url: true },
            orderBy: { sortOrder: 'asc' },
          },
          btpMaterial: { select: { sku: true } },
        },
      }),
      this.prisma.productionOrder.count({ where }),
      this.prisma.productionOrder.groupBy({
        by: ['status'],
        where: base,
        _count: { _all: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(S).map((status) => [status, 0]),
    ) as Record<ProductionStatus, number>;
    let all = 0;
    for (const group of grouped) {
      statusCounts[group.status] = group._count._all;
      all += group._count._all;
    }

    return {
      total,
      statusCounts: { ...statusCounts, ALL: all },
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        status: row.status,
        source: row.source,
        btpSku: row.btpMaterial?.sku ?? null,
        requestType: row.requestType,
        qty: row.qty,
        returnedQty: row.returnedQty,
        model3dCode: row.model3dCode,
        model3dUrl: row.model3dUrl,
        leadTime: row.leadTime,
        trackingCode: row.trackingCode,
        closedBy: row.closedBy,
        description: row.description,
        stoneColor: row.stoneColor,
        stoneTypes: row.stoneTypes,
        size: row.size,
        mainMaterial: row.mainMaterial,
        platingColor: row.platingColor,
        askedUserName: row.askedUserName,
        receivedDate: ymd(row.receivedDate),
        dueDate: row.dueDate ? ymd(row.dueDate) : null,
        debtStatus: row.debtStatus,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        images: row.images,
      })),
    };
  }

  async lookups() {
    const [users, materialTypes, closers, usedStoneTypes, leadTimes, debts] =
      await Promise.all([
        this.prisma.user.findMany({
          where: { isActive: true },
          select: {
            id: true,
            username: true,
            fullName: true,
            roleCode: true,
            extraRoles: true,
            allowedScreens: true,
          },
          orderBy: { fullName: 'asc' },
        }),
        this.prisma.materialType.findMany({
          select: { name: true },
          orderBy: { sortOrder: 'asc' },
        }),
        this.distinctValues('closedBy'),
        this.prisma.$queryRaw<Array<{ name: string }>>(
          Prisma.sql`SELECT DISTINCT unnest(stone_types) AS name FROM production_orders`,
        ),
        this.distinctValues('leadTime'),
        this.distinctValues('debtStatus'),
      ]);

    return {
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        fullName: user.fullName,
      })),
      // Tài khoản được nhận phiếu con: role Thợ, quyền Thợ sản xuất tick tay, hoặc admin.
      workerIds: users
        .filter(
          (user) =>
            user.roleCode === RoleCode.ADMIN ||
            user.extraRoles.includes(RoleCode.ADMIN) ||
            user.roleCode === RoleCode.WORKER ||
            user.extraRoles.includes(RoleCode.WORKER) ||
            user.allowedScreens.includes(Permission.PRODUCTION_WORKER),
        )
        .map((user) => user.id),
      closers: uniqueSorted([
        ...users.map((user) => user.fullName),
        ...closers,
      ]),
      stoneTypes: uniqueSorted([
        ...materialTypes
          .map((item) => item.name)
          .filter((name) => /^đá/i.test(name)),
        ...usedStoneTypes.map((item) => item.name),
      ]),
      leadTimes: unique([...DEFAULT_LEAD_TIMES, ...leadTimes]),
      debtStatuses: uniqueSorted(debts),
    };
  }

  /** Đơn chưa giao cho ô chọn "Mã đơn SX" ở phiếu xuất NVL. */
  async options(search?: string) {
    const keyword = search?.trim();
    const rows = await this.prisma.productionOrder.findMany({
      where: {
        status: { not: S.DELIVERED },
        ...(keyword
          ? {
              OR: [
                { code: { contains: keyword, mode: 'insensitive' } },
                { description: { contains: keyword, mode: 'insensitive' } },
                { trackingCode: { contains: keyword, mode: 'insensitive' } },
              ],
            }
          : null),
      },
      orderBy: { seq: 'desc' },
      take: 300,
      select: { code: true, description: true, status: true },
    });
    return rows.map((row) => ({
      code: row.code,
      description:
        row.description.length > 80
          ? `${row.description.slice(0, 80)}…`
          : row.description,
      status: row.status,
    }));
  }

  /** BTP còn tồn cho ô chọn "Mã BTP" khi lên Đơn BTP, kèm thông tin để điền sẵn vào đơn. */
  async btpOptions(search?: string) {
    const keyword = search?.trim();
    const rows = await this.prisma.material.findMany({
      where: {
        isActive: true,
        warehouse: { code: BTP_WAREHOUSE_CODE },
        balance: { qty: { gt: 0 } },
        ...(keyword
          ? {
              OR: [
                { sku: { contains: keyword, mode: 'insensitive' } },
                { name: { contains: keyword, mode: 'insensitive' } },
              ],
            }
          : null),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: 100,
      select: {
        id: true,
        sku: true,
        name: true,
        sizeLabel: true,
        unit: { select: { name: true } },
        balance: { select: { qty: true } },
        bodyMetal: { select: { name: true } },
        productKind: { select: { name: true } },
        otherClass: { select: { name: true } },
        platingColor: { select: { name: true } },
        color: { select: { name: true } },
        images: {
          select: { url: true, publicId: true, width: true, height: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      unit: row.unit.name,
      qty: decStr(row.balance?.qty),
      bodyMetal: row.bodyMetal?.name ?? null,
      productKind: row.productKind?.name ?? null,
      category: row.otherClass?.name ?? null,
      platingColor: row.platingColor?.name ?? null,
      stoneColor: row.color?.name ?? null,
      sizeLabel: row.sizeLabel,
      images: row.images,
    }));
  }

  async addCost(code: string, dto: OrderCostDto, actor: AuthUserPayload) {
    const order = await this.requireCostEditable(code);
    await this.prisma.productionOrderCost.create({
      data: {
        orderId: order.id,
        name: requireText(dto.name, 'Nhập tên khoản chi phí'),
        amount: new Prisma.Decimal(dto.amount),
        note: dto.note?.trim() || null,
        createdByName: actorName(actor),
      },
    });
    return { success: true };
  }

  async updateCost(code: string, costId: string, dto: OrderCostDto) {
    const order = await this.requireCostEditable(code);
    const { count } = await this.prisma.productionOrderCost.updateMany({
      where: { id: costId, orderId: order.id },
      data: {
        name: requireText(dto.name, 'Nhập tên khoản chi phí'),
        amount: new Prisma.Decimal(dto.amount),
        note: dto.note?.trim() || null,
      },
    });
    if (count === 0)
      throw new NotFoundException('Không tìm thấy khoản chi phí');
    return { success: true };
  }

  async removeCost(code: string, costId: string) {
    const order = await this.requireCostEditable(code);
    const { count } = await this.prisma.productionOrderCost.deleteMany({
      where: { id: costId, orderId: order.id },
    });
    if (count === 0)
      throw new NotFoundException('Không tìm thấy khoản chi phí');
    return { success: true };
  }

  /** Sửa tiền công một khâu ngay ở phần chi phí, không phải gỡ KCS nhận lại. */
  async updateStageLabor(code: string, stageId: string, dto: StageLaborDto) {
    const order = await this.requireCostEditable(code);
    const entry = await this.prisma.productionStageEntry.findFirst({
      where: { id: stageId, orderId: order.id },
      select: { id: true, returnedAt: true },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy khâu trên đơn');
    if (!entry.returnedAt) {
      throw new BadRequestException(
        'Khâu chưa được KCS nhận lại — tiền công nhập ở bước nhận lại',
      );
    }
    await this.prisma.productionStageEntry.update({
      where: { id: entry.id },
      data: { laborCost: decimalOrNull(dto.laborCost) },
    });
    await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: { dataChangedAt: new Date() },
    });
    return { success: true };
  }

  /** Đơn đã giao hết thì chi phí đã chụp lên phiếu xuất — không sửa nữa. */
  private async requireCostEditable(code: string) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: normalizeCode(code) },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    if (order.status === S.DELIVERED) {
      throw new BadRequestException(
        'Đơn đã giao, chi phí đã chốt trên phiếu xuất hàng',
      );
    }
    return order;
  }

  async detail(code: string) {
    return toDetail(await this.requireOrder(code));
  }

  /**
   * Thông tin đơn cho thợ quét QR trên phiếu giấy: đủ để làm hàng và tìm đúng phiếu con
   * của mình. Không có chi phí, kho thành phẩm, khách hàng hay lịch sử khâu của người khác.
   */
  async reference(code: string) {
    const order = await this.requireOrder(code);
    return {
      code: order.code,
      status: order.status,
      qty: order.qty,
      description: order.description,
      dueDate: order.dueDate ? ymd(order.dueDate) : null,
      size: order.size,
      sizeLabel: order.sizeLabel,
      mainMaterial: order.mainMaterial,
      platingColor: order.platingColor,
      stoneColor: order.stoneColor,
      stoneTypes: order.stoneTypes,
      stoneCount: order.stoneCount,
      laserEngraving: order.laserEngraving,
      otherRequirements: order.otherRequirements,
      images: order.images.map((image) => ({
        id: image.id,
        kind: image.kind,
        url: image.url,
      })),
      subTickets: order.subTickets.map((ticket) => {
        const entries = entriesOf(order, ticket.id);
        const { state, activeStage } = subTicketState(ticket, entries);
        return {
          code: subTicketCode(order.code, ticket.no),
          no: ticket.no,
          qty: ticket.qty,
          state,
          activeStage,
          claimedByName: ticket.claimedByName,
        };
      }),
    };
  }

  async create(dto: UpsertProductionOrderDto, actor: AuthUserPayload) {
    const fields = await this.orderFields(dto);
    const images = this.newImages(dto.images, new Set());
    const changedBy = actorName(actor);

    for (let attempt = 1; ; attempt += 1) {
      const last = await this.prisma.productionOrder.aggregate({
        _max: { seq: true },
      });
      const seq = (last._max.seq ?? 0) + 1;
      try {
        const order = await this.prisma.runTx(async (tx) => {
          const created = await tx.productionOrder.create({
            data: {
              ...fields,
              seq,
              code: orderCode(seq),
              createdBy: changedBy,
              createdByUserId: actor.id,
              images: { create: images },
              statusLogs: { create: { toStatus: S.NEW, changedBy } },
            },
            select: { id: true, code: true },
          });
          if (fields.btpMaterialId) {
            await this.inventory.issueBtpForOrder(tx, {
              orderId: created.id,
              orderCode: created.code,
              materialId: fields.btpMaterialId,
              qty: fields.qty,
              issuedAt: fields.receivedDate,
              issuedBy: changedBy,
            });
          }
          return tx.productionOrder.findUniqueOrThrow({
            where: { id: created.id },
            include: detailInclude,
          });
        });
        if (fields.btpMaterialId) this.inventory.bustBtpStock();
        await this.touchSiblings([fields.parentId], order.id);
        return toDetail(order);
      } catch (error) {
        // Hai người lên đơn cùng lúc có thể lấy trùng số — thử lại với số kế tiếp.
        if (isUniqueViolation(error) && attempt < CREATE_RETRIES) continue;
        throw error;
      }
    }
  }

  async update(
    code: string,
    dto: UpsertProductionOrderDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.requireOrder(code);
    if (order.receipt && dto.qty !== order.qty) {
      throw new BadRequestException(
        'Đơn đã vào kho thành phẩm, không đổi số lượng được',
      );
    }
    const fields = await this.orderFields(dto, order.id);
    assertCoversSubTickets(order, fields.qty, fields.silverWeight);
    // Đổi loại đơn / mã BTP / số lượng của Đơn BTP thì hoàn phiếu xuất BTP cũ và xuất lại.
    const reissue =
      fields.source !== order.source ||
      fields.btpMaterialId !== order.btpMaterialId ||
      (fields.source === ProductionSource.BTP && fields.qty !== order.qty);
    if (reissue && order.stages.length > 0) {
      throw new BadRequestException(
        'Đơn đã giao khâu cho thợ, không đổi loại đơn, mã BTP hoặc số lượng BTP được',
      );
    }
    if (
      fields.source === ProductionSource.BTP &&
      order.source !== ProductionSource.BTP &&
      order.castingSentDate
    ) {
      throw new BadRequestException(
        'Đơn đã báo Đúc, không chuyển sang Đơn BTP được',
      );
    }
    const existing = new Set(order.images.map((image) => image.publicId));
    const images = this.newImages(dto.images, existing);
    const kept = new Set(images.map((image) => image.publicId));
    const removed = order.images
      .map((image) => image.publicId)
      .filter((publicId) => !kept.has(publicId));

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          ...fields,
          dataChangedAt: new Date(),
          images: { deleteMany: {}, create: images },
        },
      });
      if (reissue) {
        await this.inventory.revokeBtpForOrder(tx, order.id);
        if (fields.btpMaterialId) {
          await this.inventory.issueBtpForOrder(tx, {
            orderId: order.id,
            orderCode: order.code,
            materialId: fields.btpMaterialId,
            qty: fields.qty,
            issuedAt: fields.receivedDate,
            issuedBy: actorName(actor),
          });
        }
      }
      return tx.productionOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: detailInclude,
      });
    });
    if (reissue) this.inventory.bustBtpStock();
    if (order.parentId !== fields.parentId) {
      await this.touchSiblings([order.parentId, fields.parentId], order.id);
    }
    await this.cloudinary.destroy(removed);
    return toDetail(updated);
  }

  async remove(code: string) {
    const order = await this.requireOrder(code);
    if (order.status !== S.NEW || order.stages.length > 0) {
      throw new BadRequestException(
        'Chỉ xóa được đơn ở trạng thái Mới và chưa giao khâu nào',
      );
    }
    if (order.children.length > 0) {
      throw new BadRequestException(
        'Đơn đang có đơn con, gỡ liên kết trước khi xóa',
      );
    }
    // Mã SX = số lớn nhất + 1 nên mã của đơn bị xóa có thể được cấp lại; không cho
    // xóa đơn đã có phiếu giấy để tránh hai phiếu cùng mã.
    if (order.lastPrintedAt || order.subTickets.some((t) => t.lastPrintedAt)) {
      throw new BadRequestException('Đơn đã in phiếu cho thợ, không xóa được');
    }
    // Phiếu xuất BTP do lên đơn tự tạo được hoàn kho cùng lúc xoá đơn.
    const manualOutbounds = await this.prisma.stockOutbound.count({
      where: { productionOrderId: order.id, autoIssued: false },
    });
    if (manualOutbounds > 0) {
      throw new BadRequestException(
        'Đơn đã có phiếu xuất NVL gắn vào, gỡ mã đơn trên phiếu xuất trước khi xóa',
      );
    }
    await this.prisma.runTx(async (tx) => {
      await this.inventory.revokeBtpForOrder(tx, order.id);
      await tx.productionOrder.delete({ where: { id: order.id } });
    });
    if (order.source === ProductionSource.BTP) this.inventory.bustBtpStock();
    await this.touchSiblings([order.parentId], order.id);
    await this.cloudinary.destroy(order.images.map((image) => image.publicId));
    return { success: true };
  }

  async changeStatus(
    code: string,
    dto: ChangeStatusDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.requireOrder(code);
    const target = dto.status;
    const note = dto.note?.trim() || null;

    if (target === S.DELIVERED) {
      throw new BadRequestException(
        'Đơn chuyển sang Đã giao khi lập phiếu xuất hàng đủ số lượng',
      );
    }
    if (!MANUAL_STATUSES.includes(target)) {
      throw new BadRequestException(
        'Đúc đổi qua "Báo Đúc", các khâu đổi khi giao thợ trên phiếu',
      );
    }
    if (order.status === target) {
      throw new BadRequestException(
        `Đơn đang ở trạng thái ${STATUS_LABEL[target]}`,
      );
    }
    if (target === S.REDO_3D && order.source === ProductionSource.BTP) {
      throw new BadRequestException('Đơn BTP không qua bước 3D');
    }
    if (order.status === S.DELIVERED) {
      throw new BadRequestException('Đơn đã giao, không đổi trạng thái được');
    }
    if (
      (target === S.NEW || target === S.REDO_3D) &&
      IN_STAGE_STATUSES.includes(order.status)
    ) {
      throw new BadRequestException(
        `Đơn đang ở khâu ${STATUS_LABEL[order.status]} — chuyển sang Sản xuất lỗi trước nếu cần làm lại`,
      );
    }
    if ((target === S.NEW || target === S.REDO_3D) && order.receipt) {
      throw new BadRequestException(
        'Đơn đang trong kho thành phẩm — chuyển sang Sản xuất lỗi để rút khỏi kho trước',
      );
    }
    if (target === S.DEFECT && !note) {
      throw new BadRequestException(
        'Ghi rõ lỗi khi chuyển đơn sang Sản xuất lỗi',
      );
    }
    if (order.receipt && order.shipmentLines.length > 0) {
      throw new BadRequestException(
        'Đơn đã có phiếu xuất hàng — xóa phiếu xuất trước nếu cần làm lại',
      );
    }
    // Hàng trong kho thành phẩm (chưa xuất) bị lỗi thì rút khỏi kho để làm lại.
    const leaveStock = target === S.DEFECT && order.receipt != null;
    // Đơn ra khỏi khâu thì các khâu đang mở chờ thợ nhận trên phiếu con cũng huỷ theo.
    const pending = order.subTickets.filter((t) => t.pendingStage).length;
    const logNote = [
      note,
      leaveStock ? '(rút khỏi kho thành phẩm)' : null,
      pending > 0 ? `(huỷ ${pending} phiếu con đang chờ nhận khâu)` : null,
    ]
      .filter(Boolean)
      .join(' ');

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        status: target,
        dataChangedAt: new Date(),
        ...(leaveStock ? { receipt: { delete: true } } : null),
        ...(pending > 0
          ? {
              subTickets: {
                updateMany: {
                  where: { pendingStage: { not: null } },
                  data: {
                    pendingStage: null,
                    pendingAt: null,
                    pendingByName: null,
                    claimedByUserId: null,
                    claimedByName: null,
                    claimedAt: null,
                  },
                },
              },
            }
          : null),
        statusLogs: {
          create: {
            fromStatus: order.status,
            toStatus: target,
            note: logNote || null,
            changedBy: actorName(actor),
          },
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /** Báo Đúc (đơn chuyển sang Đúc, từ đây mới in được phiếu) và ghi ngày Đúc về. */
  async updateCasting(code: string, dto: CastingDto, actor: AuthUserPayload) {
    const order = await this.requireOrder(code);
    if (order.source === ProductionSource.BTP) {
      throw new BadRequestException('Đơn BTP lấy hàng đúc sẵn, không qua Đúc');
    }
    if (order.status === S.DELIVERED) {
      throw new BadRequestException('Đơn đã giao, không sửa ngày đúc được');
    }
    const sentDate = dateOnly(dto.sentDate);
    const returnedDate = dto.returnedDate ? dateOnly(dto.returnedDate) : null;
    if (returnedDate && returnedDate < sentDate) {
      throw new BadRequestException(
        'Ngày Đúc về không được trước ngày báo Đúc',
      );
    }
    if (!returnedDate && order.stages.length > 0) {
      throw new BadRequestException(
        'Đơn đã giao khâu cho thợ, không bỏ ngày Đúc về được',
      );
    }
    if (!returnedDate && order.subTickets.length > 0) {
      throw new BadRequestException(
        'Đơn đã chia phiếu con, không bỏ ngày Đúc về được',
      );
    }
    // Bỏ trống Tổng TL bạc thì giữ số cũ.
    const silverWeight = decimalOrNull(dto.silverWeight);
    if (silverWeight) assertCoversSubTickets(order, order.qty, silverWeight);
    // Báo Đúc lần đầu hoặc đúc lại sau lỗi thì đơn chuyển sang Đúc.
    const toCasting = (
      [S.NEW, S.REDO_3D, S.DEFECT] as ProductionStatus[]
    ).includes(order.status);

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        castingSentDate: sentDate,
        castingReturnedDate: returnedDate,
        ...(silverWeight ? { silverWeight } : null),
        dataChangedAt: new Date(),
        ...(toCasting
          ? {
              status: S.CASTING,
              statusLogs: {
                create: {
                  fromStatus: order.status,
                  toStatus: S.CASTING,
                  note: `Báo Đúc ngày ${ymd(sentDate)}`,
                  changedBy: actorName(actor),
                },
              },
            }
          : null),
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /** Giao khâu cho thợ. Người giao là tài khoản đăng nhập. */
  async startStage(code: string, dto: StartStageDto, actor: AuthUserPayload) {
    const order = await this.requireOrder(code);
    if (order.status === S.DELIVERED) {
      throw new BadRequestException('Đơn đã giao, không giao khâu được');
    }
    // Đơn BTP lấy hàng đúc sẵn nên giao khâu ngay.
    if (
      order.source === ProductionSource.NVL &&
      (!order.castingSentDate || !order.castingReturnedDate)
    ) {
      throw new BadRequestException(
        'Ghi ngày báo Đúc và ngày Đúc về trước khi giao khâu cho thợ',
      );
    }
    if (order.receipt) {
      throw new BadRequestException(
        'Đơn đã hoàn thiện và vào kho thành phẩm — chuyển sang Sản xuất lỗi để rút khỏi kho trước khi làm lại',
      );
    }
    if (order.subTickets.length > 0) {
      throw new BadRequestException(
        'Đơn đã chia phiếu con — mở khâu và giao theo từng phiếu con',
      );
    }
    const open = order.stages.find((entry) => !entry.returnedAt);
    if (open) {
      throw new BadRequestException(
        `Khâu ${STAGE_LABEL[open.stage]} chưa được KCS nhận lại, chưa giao được khâu mới`,
      );
    }
    const last = lastStage(order);
    // Được bỏ qua khâu (hàng không đá thì không qua Vào đá) nhưng không được lùi khâu,
    // trừ khi đơn đã ra khỏi khâu (Mới / Sửa 3D / Đúc / Sản xuất lỗi) để làm lại.
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

    const craftsman = await this.resolveUser(dto.craftsmanUserId);
    const attempt =
      order.stages.filter((entry) => entry.stage === dto.stage).length + 1;
    const nextStatus = STAGE_STATUS[dto.stage];
    const changedBy = actorName(actor);

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        dataChangedAt: new Date(),
        stages: {
          create: {
            stage: dto.stage,
            attempt,
            handedByUserId: actor.id,
            handedByName: changedBy,
            handedAt: new Date(dto.handedAt),
            // Bỏ trống số lượng thì hiểu là giao cả đơn.
            handedQty: dto.handedQty ?? order.qty,
            handedSilverWeight: new Prisma.Decimal(dto.handedSilverWeight),
            craftsmanUserId: craftsman.id,
            craftsmanName: craftsman.name,
            note: dto.note?.trim() || null,
          },
        },
        statusLogs:
          order.status === nextStatus
            ? undefined
            : {
                create: {
                  fromStatus: order.status,
                  toStatus: nextStatus,
                  note: `Giao ${STAGE_LABEL[dto.stage]} cho ${craftsman.name}`,
                  changedBy,
                },
              },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /** Sửa thông tin giao khi KCS chưa nhận lại. Người giao giữ nguyên. */
  async updateHandover(code: string, stageId: string, dto: HandoverStageDto) {
    const order = await this.requireOrder(code);
    const entry = requireStage(order, stageId);
    if (entry.returnedAt) {
      throw new BadRequestException('KCS đã nhận lại khâu này, không sửa được');
    }
    // Thợ của phiếu con là người đã tự nhận khâu — không đổi ở đây.
    if (entry.subTicketId && dto.craftsmanUserId !== entry.craftsmanUserId) {
      throw new BadRequestException(
        'Khâu của phiếu con giữ nguyên thợ đã nhận, chỉ sửa được thời gian, số lượng, trọng lượng',
      );
    }
    const craftsman = await this.resolveUser(dto.craftsmanUserId);

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        dataChangedAt: new Date(),
        stages: {
          update: {
            where: { id: entry.id },
            data: {
              craftsmanUserId: craftsman.id,
              craftsmanName: craftsman.name,
              handedAt: new Date(dto.handedAt),
              handedQty:
                dto.handedQty ??
                (entry.subTicketId ? entry.handedQty : order.qty),
              handedSilverWeight: new Prisma.Decimal(dto.handedSilverWeight),
              note: dto.note?.trim() || null,
            },
          },
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /** KCS nhận lại hàng từ thợ, cân lại bạc. Người KCS là tài khoản đăng nhập. */
  async returnStage(
    code: string,
    stageId: string,
    dto: ReturnStageDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.requireOrder(code);
    const entry = requireStage(order, stageId);
    if (entry.returnedAt) {
      throw new BadRequestException('KCS đã nhận lại khâu này');
    }
    const returnedAt = new Date(dto.returnedAt);
    if (returnedAt < entry.handedAt) {
      throw new BadRequestException(
        'Thời gian nhận lại không được trước thời gian giao',
      );
    }
    const handedQty = entry.handedQty ?? order.qty;
    const returnedQty = dto.returnedQty ?? handedQty;
    if (returnedQty > handedQty) {
      throw new BadRequestException(
        `Số lượng nhận lại không được nhiều hơn số đã giao (${handedQty})`,
      );
    }
    const kcsName = actorName(actor);

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        dataChangedAt: new Date(),
        stages: {
          update: {
            where: { id: entry.id },
            data: {
              returnedByUserId: actor.id,
              returnedByName: kcsName,
              returnedAt,
              returnedQty,
              returnedSilverWeight: new Prisma.Decimal(
                dto.returnedSilverWeight,
              ),
              btpRecoveredWeight: decimalOrNull(dto.btpRecoveredWeight),
              silverRecoveredWeight: decimalOrNull(dto.silverRecoveredWeight),
              laborCost: decimalOrNull(dto.laborCost),
              // Ghi chú lúc nhận lại nối vào ghi chú lúc giao, không ghi đè.
              note: joinNotes(entry.note, dto.note),
            },
          },
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /**
   * Kết phiếu ở nhánh Hoàn thiện (thay cho khâu Ngoại Quan cũ): KCS chốt hàng đạt,
   * đơn sang Hoàn thiện và vào kho thành phẩm đủ số lượng.
   */
  async finish(code: string, dto: FinishOrderDto, actor: AuthUserPayload) {
    const order = await this.requireOrder(code);
    if (order.status === S.DELIVERED) {
      throw new BadRequestException('Đơn đã giao');
    }
    if (order.receipt) {
      throw new BadRequestException('Đơn đã hoàn thiện, đang ở kho thành phẩm');
    }
    if (order.status === S.NEW || order.status === S.REDO_3D) {
      throw new BadRequestException(
        'Đơn chưa vào sản xuất, chưa hoàn thiện được',
      );
    }
    if (order.subTickets.length > 0) {
      throw new BadRequestException(
        'Đơn đã chia phiếu con — chốt Hoàn thiện ở từng phiếu con',
      );
    }
    const open = order.stages.find((entry) => !entry.returnedAt);
    if (open) {
      throw new BadRequestException(
        `Khâu ${STAGE_LABEL[open.stage]} chưa được KCS nhận lại, chưa hoàn thiện được`,
      );
    }
    const pending = order.subTickets.find((t) => t.pendingStage);
    if (pending?.pendingStage) {
      throw new BadRequestException(
        `Phiếu ${subTicketCode(order.code, pending.no)} đang mở khâu ${STAGE_LABEL[pending.pendingStage]} — huỷ mở khâu trước khi hoàn thiện`,
      );
    }
    const finishedAt = dto.finishedAt ? new Date(dto.finishedAt) : new Date();
    const changedBy = actorName(actor);

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        status: S.FINISHING,
        dataChangedAt: new Date(),
        receipt: {
          create: {
            qty: order.qty,
            receivedAt: finishedAt,
            receivedByUserId: actor.id,
            receivedByName: changedBy,
          },
        },
        statusLogs: {
          create: {
            fromStatus: order.status,
            toStatus: S.FINISHING,
            note: dto.note?.trim() || null,
            changedBy,
          },
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /** Admin gỡ hoàn thiện để sửa sai: đơn ra khỏi kho thành phẩm, về lại khâu cuối. */
  async undoFinish(code: string, actor: AuthUserPayload) {
    const order = await this.requireOrder(code);
    if (!order.receipt) {
      throw new BadRequestException('Đơn chưa hoàn thiện');
    }
    // Đơn chia phiếu con: kho thành phẩm cộng từ kết cục từng phiếu, gỡ ở phiếu con.
    if (order.subTickets.some((ticket) => ticket.outcome)) {
      throw new BadRequestException(
        'Đơn hoàn thiện theo phiếu con — gỡ kết cục ở từng phiếu con',
      );
    }
    if (order.shipmentLines.length > 0) {
      throw new BadRequestException(
        'Đơn đã có phiếu xuất hàng, xóa phiếu xuất trước khi gỡ hoàn thiện',
      );
    }
    const last = lastStage(order);
    const back = last ? STAGE_STATUS[last.stage] : S.CASTING;

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        status: back,
        dataChangedAt: new Date(),
        receipt: { delete: true },
        statusLogs: {
          create: {
            fromStatus: order.status,
            toStatus: back,
            note: 'Gỡ hoàn thiện, rút khỏi kho thành phẩm',
            changedBy: actorName(actor),
          },
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /** Admin gỡ lần nhận lại để sửa sai; chỉ áp dụng cho khâu cuối. */
  async undoReturn(code: string, stageId: string, actor: AuthUserPayload) {
    const order = await this.requireOrder(code);
    const entry = requireStage(order, stageId);
    if (!entry.returnedAt) {
      throw new BadRequestException('KCS chưa nhận lại khâu này');
    }
    // Khâu cuối tính trong từng phiếu con (hoặc trong các khâu cấp đơn).
    const scope = order.stages.filter(
      (item) => item.subTicketId === entry.subTicketId,
    );
    if (scope[scope.length - 1]?.id !== entry.id) {
      throw new BadRequestException(
        entry.subTicketId
          ? 'Chỉ gỡ nhận lại được khâu cuối cùng của phiếu con'
          : 'Chỉ gỡ nhận lại được khâu cuối cùng',
      );
    }
    if (!entry.subTicketId && order.subTickets.length > 0) {
      throw new BadRequestException(
        'Đơn đã chia phiếu con, không gỡ nhận lại khâu của cả đơn được',
      );
    }
    const ticket = order.subTickets.find((t) => t.id === entry.subTicketId);
    if (ticket?.outcome) {
      throw new BadRequestException(
        `Phiếu ${subTicketCode(order.code, ticket.no)} đã chốt lỗi / hoàn thiện — gỡ kết cục phiếu con trước khi gỡ nhận lại`,
      );
    }
    if (ticket?.pendingStage) {
      throw new BadRequestException(
        `Phiếu ${subTicketCode(order.code, ticket.no)} đã mở khâu ${STAGE_LABEL[ticket.pendingStage]} — huỷ mở khâu trước khi gỡ nhận lại`,
      );
    }
    if (order.status === S.DELIVERED) {
      throw new BadRequestException('Đơn đã giao, không gỡ nhận lại được');
    }
    if (order.receipt) {
      throw new BadRequestException(
        'Đơn đã hoàn thiện và vào kho thành phẩm — gỡ hoàn thiện trước khi sửa khâu',
      );
    }

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        dataChangedAt: new Date(),
        stages: {
          update: {
            where: { id: entry.id },
            data: {
              returnedByUserId: null,
              returnedByName: null,
              returnedAt: null,
              returnedQty: null,
              returnedSilverWeight: null,
              btpRecoveredWeight: null,
              silverRecoveredWeight: null,
              laborCost: null,
            },
          },
        },
        statusLogs: {
          create: {
            fromStatus: order.status,
            toStatus: order.status,
            note: `Gỡ nhận lại khâu ${STAGE_LABEL[entry.stage]} (KCS: ${entry.returnedByName ?? '—'})`,
            changedBy: actorName(actor),
          },
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  async markPrinted(code: string) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: normalizeCode(code) },
      select: { id: true, source: true, castingSentDate: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    // Đơn BTP lấy hàng đúc sẵn nên in được ngay.
    if (order.source === ProductionSource.NVL && !order.castingSentDate) {
      throw new BadRequestException('Chỉ in phiếu thợ khi đơn đã báo Đúc');
    }
    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: { lastPrintedAt: new Date() },
      select: { lastPrintedAt: true },
    });
    return { lastPrintedAt: updated.lastPrintedAt?.toISOString() ?? null };
  }

  /**
   * Phân đơn (2/3) tính từ các đơn con cùng mẹ — thêm / bớt đơn con làm phiếu đã in của
   * các đơn anh em bị sai, nên đánh dấu dữ liệu đã đổi để trang chi tiết nhắc in lại.
   */
  private async touchSiblings(parentIds: Array<string | null>, selfId: string) {
    const ids = unique(parentIds.filter((id): id is string => Boolean(id)));
    if (ids.length === 0) return;
    await this.prisma.productionOrder.updateMany({
      where: { parentId: { in: ids }, id: { not: selfId } },
      data: { dataChangedAt: new Date() },
    });
  }

  private async requireOrder(code: string) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: normalizeCode(code) },
      include: detailInclude,
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    return order;
  }

  private async orderFields(dto: UpsertProductionOrderDto, selfId?: string) {
    const description = dto.description.trim();
    if (!description) {
      throw new BadRequestException(
        'Mô tả / yêu cầu sản phẩm không được trống',
      );
    }
    const closedBy = dto.closedBy.trim();
    if (!closedBy) throw new BadRequestException('Nhập người chốt đơn');
    const receivedDate = dateOnly(dto.receivedDate);
    const dueDate = dto.dueDate ? dateOnly(dto.dueDate) : null;
    if (dueDate && dueDate < receivedDate) {
      throw new BadRequestException(
        'Ngày cần trả không được trước ngày đặt đơn',
      );
    }

    const asked = dto.askedUserId
      ? await this.resolveUser(dto.askedUserId)
      : null;

    let parentId: string | null = null;
    const parentCode = dto.parentCode?.trim();
    if (parentCode) {
      const parent = await this.prisma.productionOrder.findUnique({
        where: { code: normalizeCode(parentCode) },
        select: { id: true, parentId: true },
      });
      if (!parent) {
        throw new BadRequestException(`Không tìm thấy đơn mẹ ${parentCode}`);
      }
      if (parent.id === selfId || (selfId && parent.parentId === selfId)) {
        throw new BadRequestException('Đơn mẹ không hợp lệ');
      }
      parentId = parent.id;
    }

    const btpMaterialId =
      dto.source === ProductionSource.BTP
        ? await this.resolveBtpMaterial(dto.btpMaterialId)
        : null;

    return {
      source: dto.source,
      btpMaterialId,
      requestType: dto.requestType,
      receivedDate,
      dueDate,
      closedBy,
      description,
      qty: dto.qty,
      model3dCode: optional(dto.model3dCode),
      model3dUrl: optional(dto.model3dUrl),
      leadTime: optional(dto.leadTime),
      trackingCode: optional(dto.trackingCode),
      stoneColor: optional(dto.stoneColor),
      stoneTypes: unique(
        (dto.stoneTypes ?? []).map((item) => item.trim()).filter(Boolean),
      ),
      stoneCount: dto.stoneCount ?? null,
      stoneWeight: decimalOrNull(dto.stoneWeight),
      silverWeight: decimalOrNull(dto.silverWeight),
      size: optional(dto.size),
      sizeLabel: optional(dto.sizeLabel),
      mainMaterial: optional(dto.mainMaterial),
      platingColor: optional(dto.platingColor),
      laserEngraving: optional(dto.laserEngraving),
      otherRequirements: optional(dto.otherRequirements),
      askedUserId: asked?.id ?? null,
      askedUserName: asked?.name ?? null,
      debtStatus: optional(dto.debtStatus),
      parentId,
    };
  }

  /** Ảnh mới phải nằm trong thư mục Cloudinary của hệ thống; ảnh đã có trên đơn thì giữ nguyên. */
  private newImages(images: OrderImageDto[], existing: Set<string>) {
    const seen = new Set<string>();
    const counters = { DETAIL: 0, PRODUCT: 0 };
    return images
      .filter((image) => {
        if (seen.has(image.publicId)) return false;
        seen.add(image.publicId);
        return true;
      })
      .map((image) => {
        if (!existing.has(image.publicId)) {
          const host = new URL(image.url).hostname;
          if (
            host !== 'res.cloudinary.com' ||
            !this.cloudinary.ownsPublicId(image.publicId)
          ) {
            throw new BadRequestException(
              'Ảnh không thuộc kho ảnh của hệ thống',
            );
          }
        }
        return {
          kind: image.kind,
          url: image.url,
          publicId: image.publicId,
          width: image.width ?? null,
          height: image.height ?? null,
          sortOrder: counters[image.kind]++,
        };
      });
  }

  /** Tồn kiểm tra lúc xuất trong transaction — ở đây chỉ chắc mã nằm trong kho BTP. */
  private async resolveBtpMaterial(materialId: string | null | undefined) {
    if (!materialId) throw new BadRequestException('Chọn mã BTP cho Đơn BTP');
    const material = await this.prisma.material.findFirst({
      where: {
        id: materialId,
        isActive: true,
        warehouse: { code: BTP_WAREHOUSE_CODE },
      },
      select: { id: true },
    });
    if (!material) {
      throw new BadRequestException('Không tìm thấy mã BTP trong kho BTP');
    }
    return material.id;
  }

  private async resolveUser(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, fullName: true, username: true },
    });
    if (!user) {
      throw new BadRequestException('Chọn người từ tài khoản hệ thống');
    }
    return { id: user.id, name: actorName(user) };
  }

  /** Giá trị đã từng nhập, dùng làm gợi ý. Tên cột lấy từ bảng cố định nên ghép vào SQL an toàn. */
  private async distinctValues(field: keyof typeof SUGGEST_COLUMNS) {
    const column = Prisma.raw(SUGGEST_COLUMNS[field]);
    const rows = await this.prisma.$queryRaw<Array<{ value: string }>>(
      Prisma.sql`SELECT DISTINCT ${column} AS value FROM production_orders WHERE ${column} IS NOT NULL LIMIT 200`,
    );
    return rows.map((row) => row.value);
  }
}

function lastStage(order: OrderDetail): StageEntry | undefined {
  return order.stages[order.stages.length - 1];
}

/** Số lượng / Tổng TL bạc của đơn không được nhỏ hơn phần đã chia cho phiếu con. */
function assertCoversSubTickets(
  order: OrderDetail,
  qty: number,
  silverWeight: Prisma.Decimal | null,
) {
  if (order.subTickets.length === 0) return;
  const splitQty = order.subTickets.reduce((sum, t) => sum + t.qty, 0);
  const splitSilver = order.subTickets.reduce(
    (sum, t) => sum.add(t.silverWeight),
    new Prisma.Decimal(0),
  );
  if (qty < splitQty) {
    throw new BadRequestException(
      `Số lượng đơn không được nhỏ hơn tổng số lượng đã chia phiếu con (${splitQty})`,
    );
  }
  if (!silverWeight) {
    throw new BadRequestException(
      'Đơn đã chia phiếu con, không bỏ trống Tổng TL bạc được',
    );
  }
  if (silverWeight.lt(splitSilver)) {
    throw new BadRequestException(
      `Tổng TL bạc không được nhỏ hơn tổng gram đã chia phiếu con (${decStr(splitSilver)} g)`,
    );
  }
}

function requireText(value: string, message: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException(message);
  return trimmed;
}

function joinNotes(previous: string | null, next: string | undefined) {
  const added = next?.trim();
  if (!added) return previous;
  return previous ? `${previous}\n${added}` : added;
}

export function orderCode(seq: number) {
  return `A${String(seq).padStart(3, '0')}`;
}

function optional(value: string | null | undefined) {
  return value?.trim() || null;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function uniqueSorted(values: string[]) {
  return unique(values.map((value) => value.trim()).filter(Boolean)).sort(
    (a, b) => a.localeCompare(b, 'vi'),
  );
}

function dateOnly(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
