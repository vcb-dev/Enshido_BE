import {
  BadRequestException,
  Injectable,
  Logger,
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
import { decStr, METAL_KIND_LABEL } from '../util/money';
import { InflightMap, TtlCache } from '../util/ttl-cache';
import { silverLossOf } from './stage-math';
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
  subTicketSummary,
  toDetail,
  ymd,
} from './order-detail';

const S = ProductionStatus;
type WarehouseMaterial = {
  id: string;
  name: string;
  sku: string | null;
  warehouseId: string;
  unit: { id: string; name: string };
};

/**
 * Đổi tay được. Đúc đi qua báo Đúc, các khâu đi qua giao thợ, Đã giao đến từ phiếu xuất
 * hàng — để phiếu thợ, kho thành phẩm và hệ thống luôn khớp.
 */
const MANUAL_STATUSES: ProductionStatus[] = [S.NEW, S.REDO_3D, S.DEFECT];

const DEFAULT_LEAD_TIMES = ['3-5 ngày', '7-15 ngày', '15-30 ngày'];

const SUGGEST_FIELDS = ['closedBy', 'leadTime', 'debtStatus'] as const;

const CREATE_RETRIES = 3;
const LOOKUPS_TTL_MS = 2 * 60_000;

const BTP_WAREHOUSE_CODE = 'btp-cho-vao-da';
const NVL_WAREHOUSE_CODE = 'nvl-chinh';

@Injectable()
export class ProductionOrdersService {
  private readonly logger = new Logger(ProductionOrdersService.name);
  private readonly cache = new TtlCache();
  private readonly inflight = new InflightMap();

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

    const base: Prisma.ProductionOrderWhereInput = {
      NOT: { trackingCode: { startsWith: 'KHO-' } },
    };
    if (query.requestType) base.requestType = query.requestType;
    if (query.source) base.source = query.source;
    if (query.receivedDate) base.receivedDate = dateOnly(query.receivedDate);
    if (query.dueDate) base.dueDate = dateOnly(query.dueDate);
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
        select: {
          id: true,
          code: true,
          status: true,
          source: true,
          requestType: true,
          qty: true,
          qtyUnit: true,
          finishedProductQty: true,
          returnedQty: true,
          model3dCode: true,
          model3dUrl: true,
          leadTime: true,
          trackingCode: true,
          closedBy: true,
          description: true,
          stoneColor: true,
          stoneTypes: true,
          size: true,
          sizeLabel: true,
          mainMaterial: true,
          platingColor: true,
          btpCategory: true,
          productKind: true,
          askedUserName: true,
          receivedDate: true,
          dueDate: true,
          debtStatus: true,
          createdAt: true,
          updatedAt: true,
          btpMaterial: { select: { sku: true } },
          // Phiếu con kèm các khâu của chúng — vừa đủ để tính trạng thái từng phiếu cho cột
          // "Phiếu con" ở danh sách, không kéo cả chi tiết đơn.
          subTickets: {
            orderBy: { no: 'asc' },
            select: {
              id: true,
              no: true,
              qty: true,
              silverWeight: true,
              note: true,
              createdAt: true,
              pendingStage: true,
              claimedByUserId: true,
              claimedByName: true,
              outcome: true,
            },
          },
          stages: {
            where: { subTicketId: { not: null } },
            orderBy: { createdAt: 'asc' },
            select: {
              subTicketId: true,
              stage: true,
              returnedAt: true,
              submittedAt: true,
              craftsmanName: true,
            },
          },
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
        qtyUnit: row.qtyUnit,
        finishedProductQty: row.finishedProductQty,
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
        sizeLabel: row.sizeLabel,
        mainMaterial: row.mainMaterial,
        platingColor: row.platingColor,
        btpCategory: row.btpCategory,
        productKind: row.productKind,
        askedUserName: row.askedUserName,
        receivedDate: ymd(row.receivedDate),
        dueDate: row.dueDate ? ymd(row.dueDate) : null,
        debtStatus: row.debtStatus,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        images: [],
        subTickets: row.subTickets.map((ticket) =>
          subTicketSummary(
            row.code,
            ticket,
            row.stages.filter((entry) => entry.subTicketId === ticket.id),
          ),
        ),
      })),
    };
  }

  async lookups() {
    type Lookups = Awaited<ReturnType<ProductionOrdersService['loadLookups']>>;
    const hit = this.cache.get<Lookups>('lookups');
    if (hit) return hit;
    return this.inflight.run('lookups', async () => {
      const again = this.cache.get<Lookups>('lookups');
      if (again) return again;
      const value = await this.loadLookups();
      this.cache.set('lookups', value, LOOKUPS_TTL_MS);
      return value;
    });
  }

  private async loadLookups() {
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
          select: { code: true, name: true },
          orderBy: { sortOrder: 'asc' },
        }),
        this.distinctValues('closedBy'),
        this.usedStoneTypes(),
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
          .filter((item) => !['ccdc', 'nvl-phu'].includes(item.code))
          .map((item) => item.name),
        ...usedStoneTypes,
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

  /** Mã thành phẩm trong kho thành phẩm — chọn để điền sẵn form Đơn mới. */
  async finishedProductOptions(search?: string) {
    const keyword = search?.trim();
    const receipts = await this.prisma.finishedGoodsReceipt.findMany({
      where: keyword
        ? {
            order: {
              OR: [
                { code: { contains: keyword, mode: 'insensitive' } },
                { description: { contains: keyword, mode: 'insensitive' } },
                { trackingCode: { contains: keyword, mode: 'insensitive' } },
              ],
            },
          }
        : undefined,
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: {
        order: {
          select: {
            code: true,
            description: true,
            requestType: true,
            qty: true,
            size: true,
            sizeLabel: true,
            mainMaterial: true,
            platingColor: true,
            stoneColor: true,
            stoneTypes: true,
            stoneCount: true,
            stoneWeight: true,
            laserEngraving: true,
            otherRequirements: true,
            // Trả đủ ảnh mọi loại: form lên đơn chép cả bộ ảnh sản phẩm (không có thì lấy ảnh
            // loại khác) sang đơn mới, không chỉ lấy ảnh đại diện.
            images: {
              select: {
                kind: true,
                url: true,
                publicId: true,
                width: true,
                height: true,
              },
              orderBy: { sortOrder: 'asc' },
            },
            shipmentLines: { select: { qty: true } },
          },
        },
      },
    });

    const seen = new Set<string>();
    const items = [];
    for (const receipt of receipts) {
      if (seen.has(receipt.order.code)) continue;
      seen.add(receipt.order.code);
      const shippedQty = receipt.order.shipmentLines.reduce((sum, line) => sum + line.qty, 0);
      items.push({
        code: receipt.order.code,
        description: receipt.order.description,
        requestType: receipt.order.requestType,
        qty: receipt.order.qty,
        size: receipt.order.size,
        sizeLabel: receipt.order.sizeLabel,
        mainMaterial: receipt.order.mainMaterial,
        platingColor: receipt.order.platingColor,
        stoneColor: receipt.order.stoneColor,
        stoneTypes: receipt.order.stoneTypes,
        stoneCount: receipt.order.stoneCount,
        stoneWeight: receipt.order.stoneWeight != null ? decStr(receipt.order.stoneWeight) : null,
        laserEngraving: receipt.order.laserEngraving,
        otherRequirements: receipt.order.otherRequirements,
        remainingQty: receipt.qty - shippedQty,
        images: receipt.order.images,
      });
      if (items.length >= 100) break;
    }
    return items;
  }

  /** Mã NVL kho nguyên liệu chính — chọn để điền sẵn form Đơn mới. */
  async nvlOptions(search?: string) {
    const keyword = search?.trim();
    const rows = await this.prisma.material.findMany({
      where: {
        isActive: true,
        warehouse: { code: NVL_WAREHOUSE_CODE },
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
        note: true,
        metalKind: true,
        unit: { select: { name: true } },
        balance: { select: { qty: true } },
        materialType: { select: { name: true } },
        bodyMetal: { select: { name: true } },
        shape: { select: { name: true } },
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
      shape: row.shape?.name ?? null,
      color: row.color?.name ?? null,
      materialType: row.materialType?.name ?? null,
      bodyMetal: row.bodyMetal?.name ?? null,
      metalKind: row.metalKind ? (METAL_KIND_LABEL[row.metalKind] ?? row.metalKind) : null,
      sizeLabel: row.sizeLabel,
      note: row.note,
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
    const started = Date.now();
    this.logger.log(`Lên đơn ${dto.source}…`);
    const fields = await this.orderFields(dto);
    const { btpMaterial, nvlMaterial, ...data } = fields;
    const images = this.newImages(dto.images, new Set());
    const changedBy = actorName(actor);

    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.prisma.runTx(async (tx) => {
          const last = await tx.productionOrder.findFirst({
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          const seq = (last?.seq ?? 0) + 1;
          const initialStatus =
            data.source === ProductionSource.BTP ? S.FILING : S.NEW;
          const row = await tx.productionOrder.create({
            data: {
              ...data,
              seq,
              status: initialStatus,
              code: orderCode(seq),
              createdBy: changedBy,
              createdByUserId: actor.id,
              images: { create: images },
              statusLogs: { create: { toStatus: initialStatus, changedBy } },
            },
            include: {
              images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
              statusLogs: { orderBy: { changedAt: 'desc' } },
            },
          });
          await this.issueAutoStockForOrder(tx, {
            orderId: row.id,
            orderCode: row.code,
            issuedAt: data.receivedDate,
            issuedBy: changedBy,
            actorId: actor.id,
            source: data.source,
            btpMaterial,
            nvlMaterial,
            btpQty: data.finishedProductQty ?? data.qty,
            nvlQty: data.stoneCount ?? 0,
            sourceOrderCode: data.sourceOrderCode,
            finishedProductQty: data.finishedProductQty ?? 0,
          });
          return row;
        });
        if (btpMaterial) this.inventory.bustBtpStock();
        if (nvlMaterial) this.inventory.bustNvlStock();
        await this.touchSiblings([data.parentId], created.id);
        this.logger.log(`Đã lên đơn ${created.code} (${Date.now() - started}ms)`);
        return toDetail(
          asCreatedDetail(
            created,
            btpMaterial,
            nvlMaterial,
            Number(Boolean(btpMaterial)) + Number(Boolean(nvlMaterial)),
          ),
        );
      } catch (error) {
        // Hai người lên đơn cùng lúc có thể lấy trùng số — thử lại với số kế tiếp.
        if (isUniqueViolation(error) && attempt < CREATE_RETRIES) continue;
        this.logger.error(
          `Lên đơn ${dto.source} lỗi sau ${Date.now() - started}ms`,
          error instanceof Error ? error.stack : String(error),
        );
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
    const { btpMaterial, nvlMaterial, ...fields } = await this.orderFields(
      dto,
      order.id,
    );
    assertCoversSubTickets(order, fields.qty, fields.silverWeight);
    // Đổi loại đơn / mã / số lượng tự xuất thì hoàn phiếu cũ và xuất lại.
    const reissue =
      fields.source !== order.source ||
      fields.btpMaterialId !== order.btpMaterialId ||
      fields.nvlMaterialId !== order.nvlMaterialId ||
      fields.sourceOrderCode !== order.sourceOrderCode ||
      (fields.finishedProductQty ?? fields.qty) !==
        (order.finishedProductQty ?? order.qty) ||
      (fields.stoneCount ?? 0) !== (order.stoneCount ?? 0) ||
      (fields.source === ProductionSource.BTP && fields.qty !== order.qty);
    if (reissue && order.stages.length > 0) {
      throw new BadRequestException(
        'Đơn đã giao khâu cho thợ, không đổi loại đơn, mã hoặc số lượng xuất kho được',
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
    const becomeBtp =
      fields.source === ProductionSource.BTP &&
      order.source !== ProductionSource.BTP &&
      order.status === S.NEW &&
      order.stages.length === 0;
    const changedBy = actorName(actor);

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          ...fields,
          dataChangedAt: new Date(),
          images: { deleteMany: {}, create: images },
          ...(becomeBtp
            ? {
                status: S.FILING,
                statusLogs: {
                  create: {
                    fromStatus: order.status,
                    toStatus: S.FILING,
                    changedBy,
                  },
                },
              }
            : {}),
        },
      });
      if (reissue) {
        await this.inventory.revokeBtpForOrder(tx, order.id);
        await this.revokeFinishedGoodsForOrder(tx, order.id);
        await this.issueAutoStockForOrder(tx, {
          orderId: order.id,
          orderCode: order.code,
          issuedAt: fields.receivedDate,
          issuedBy: changedBy,
          actorId: actor.id,
          source: fields.source,
          btpMaterial,
          nvlMaterial,
          btpQty: fields.finishedProductQty ?? fields.qty,
          nvlQty: fields.stoneCount ?? 0,
          sourceOrderCode: fields.sourceOrderCode,
          finishedProductQty: fields.finishedProductQty ?? 0,
        });
      }
      return order.id;
    });
    if (reissue) {
      if (btpMaterial || order.source === ProductionSource.BTP) this.inventory.bustBtpStock();
      if (
        nvlMaterial ||
        order.source === ProductionSource.NVL ||
        order.source === ProductionSource.BTP
      ) {
        this.inventory.bustNvlStock();
      }
    }
    this.cache.delete('lookups');
    if (order.parentId !== fields.parentId) {
      await this.touchSiblings([order.parentId, fields.parentId], order.id);
    }
    await this.cloudinary.destroy(removed);
    return toDetail(
      await this.prisma.productionOrder.findUniqueOrThrow({
        where: { id: updated },
        include: detailInclude,
      }),
    );
  }

  async remove(code: string) {
    const order = await this.requireOrder(code);
    const freshBtp =
      order.source === ProductionSource.BTP && order.status === S.FILING;
    if ((!freshBtp && order.status !== S.NEW) || order.stages.length > 0) {
      throw new BadRequestException(
        'Chỉ xóa được đơn mới tạo và chưa giao khâu nào',
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
    // Phiếu xuất do lên đơn tự tạo được hoàn kho cùng lúc xoá đơn.
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
      await this.revokeFinishedGoodsForOrder(tx, order.id);
      await tx.productionOrder.delete({ where: { id: order.id } });
    });
    if (order.source === ProductionSource.BTP) this.inventory.bustBtpStock();
    if (
      order.source === ProductionSource.NVL ||
      order.source === ProductionSource.BTP
    ) {
      this.inventory.bustNvlStock();
    }
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
    // Phiếu con: thợ phải báo đã làm xong thì KCS mới nhận lại. Khâu của cả đơn (giao trước
    // lúc chia phiếu con) không có bước báo xong nên không áp luật này, kẻo kẹt vĩnh viễn.
    if (entry.subTicketId && !entry.submittedAt) {
      throw new BadRequestException(
        'Thợ chưa báo làm xong khâu này — chờ thợ bấm "Đã làm xong" rồi KCS mới nhận lại',
      );
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
    const description = dto.description?.trim() ?? '';
    const closedBy = dto.closedBy.trim();
    if (!closedBy) throw new BadRequestException('Nhập người chốt đơn');
    const trackingCode = dto.trackingCode?.trim();
    if (!trackingCode) throw new BadRequestException('Nhập mã theo dõi đơn');
    const leadTime = dto.leadTime?.trim();
    if (!leadTime) throw new BadRequestException('Nhập thời gian cần hoàn thành');
    const receivedDate = dateOnly(dto.receivedDate);
    if (!dto.dueDate) throw new BadRequestException('Nhập ngày cần trả');
    const dueDate = dateOnly(dto.dueDate);
    if (dueDate < receivedDate) {
      throw new BadRequestException(
        'Ngày cần trả không được trước ngày đặt đơn',
      );
    }

    const askedUserId = dto.askedUserId;
    const parentCode = dto.parentCode?.trim();
    const [asked, parent, btpMaterial, nvlMaterial, sourceOrderCode] = await Promise.all([
      askedUserId ? this.resolveUser(askedUserId) : Promise.resolve(null),
      parentCode
        ? this.prisma.productionOrder.findUnique({
            where: { code: normalizeCode(parentCode) },
            select: { id: true, parentId: true },
          })
        : Promise.resolve(null),
      dto.source === ProductionSource.BTP
        ? this.resolveBtpMaterial(dto.btpMaterialId)
        : Promise.resolve(null),
      this.resolveNvlMaterial(dto.nvlMaterialId),
      dto.source === ProductionSource.NVL
        ? this.resolveSourceFinishedProduct(
            dto.finishedProductCode,
            dto.finishedProductQty ?? 0,
            selfId,
          )
        : Promise.resolve(null),
    ]);

    if (!(dto.stoneCount && dto.stoneCount >= 1)) {
      throw new BadRequestException('Nhập số lượng NVL cần lên đơn');
    }
    if (
      dto.source === ProductionSource.NVL &&
      !(dto.finishedProductQty && dto.finishedProductQty >= 1)
    ) {
      throw new BadRequestException('Nhập số lượng thành phẩm cần lên đơn');
    }
    if (
      dto.source === ProductionSource.BTP &&
      !(dto.finishedProductQty && dto.finishedProductQty >= 1)
    ) {
      throw new BadRequestException('Nhập số lượng BTP cần lên đơn');
    }

    let parentId: string | null = null;
    if (parentCode) {
      if (!parent) {
        throw new BadRequestException(`Không tìm thấy đơn mẹ ${parentCode}`);
      }
      if (parent.id === selfId || (selfId && parent.parentId === selfId)) {
        throw new BadRequestException('Đơn mẹ không hợp lệ');
      }
      parentId = parent.id;
    }

    return {
      source: dto.source,
      btpMaterialId: btpMaterial?.id ?? null,
      nvlMaterialId: nvlMaterial?.id ?? null,
      sourceOrderCode,
      btpMaterial,
      nvlMaterial,
      requestType: dto.requestType,
      receivedDate,
      dueDate,
      closedBy,
      description,
      qty: dto.qty,
      qtyUnit: optional(dto.qtyUnit),
      finishedProductQty: dto.finishedProductQty ?? null,
      model3dCode: optional(dto.model3dCode),
      model3dUrl: optional(dto.model3dUrl),
      leadTime,
      trackingCode,
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
      btpCategory: optional(dto.btpCategory),
      productKind: optional(dto.productKind),
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

  /** Tồn kiểm tra lúc xuất trong transaction — lấy đủ thông tin để xuất, không query lại. */
  private async resolveBtpMaterial(materialId: string | null | undefined) {
    if (!materialId) throw new BadRequestException('Chọn mã BTP cho Đơn BTP');
    return this.resolveWarehouseMaterial(
      materialId,
      BTP_WAREHOUSE_CODE,
      'Không tìm thấy mã BTP trong kho BTP',
    );
  }

  private async resolveNvlMaterial(materialId: string | null | undefined) {
    if (!materialId) throw new BadRequestException('Chọn mã NVL');
    return this.resolveWarehouseMaterial(
      materialId,
      NVL_WAREHOUSE_CODE,
      'Không tìm thấy mã NVL trong kho NVL chính',
    );
  }

  private async resolveSourceFinishedProduct(
    code: string | null | undefined,
    qty: number,
    selfId?: string,
  ) {
    if (!code?.trim()) throw new BadRequestException('Chọn mã thành phẩm cho Đơn mới');
    if (qty < 1) throw new BadRequestException('Nhập số lượng thành phẩm cần lên đơn');
    const orderCode = normalizeCode(code);
    const source = await this.prisma.productionOrder.findUnique({
      where: { code: orderCode },
      select: {
        id: true,
        code: true,
        receipt: { select: { qty: true } },
        shipmentLines: {
          select: {
            qty: true,
            shipment: { select: { createdByOrderId: true } },
          },
        },
      },
    });
    if (!source?.receipt) {
      throw new BadRequestException(
        `Không tìm thấy mã ${orderCode} trong kho thành phẩm`,
      );
    }
    const shipped = source.shipmentLines.reduce((sum, line) => {
      if (selfId && line.shipment.createdByOrderId === selfId) return sum;
      return sum + line.qty;
    }, 0);
    const remaining = source.receipt.qty - shipped;
    if (qty > remaining) {
      throw new BadRequestException(
        `Đơn ${orderCode} chỉ còn ${remaining} trong kho thành phẩm`,
      );
    }
    return source.code;
  }

  /** Xuất kho gắn đơn: BTP và/hoặc NVL; Đơn mới thêm xuất thành phẩm nguồn. */
  private async issueAutoStockForOrder(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      orderCode: string;
      issuedAt: Date;
      issuedBy: string;
      actorId: string;
      source: ProductionSource;
      btpMaterial: WarehouseMaterial | null;
      nvlMaterial: WarehouseMaterial | null;
      btpQty: number;
      nvlQty: number;
      sourceOrderCode: string | null;
      finishedProductQty: number;
    },
  ) {
    if (params.btpMaterial || params.nvlMaterial) {
      await tx.$executeRaw`SELECT set_config('lock_timeout', '2000', true)`;
    }
    if (params.btpMaterial) {
      await this.inventory.issueStockForOrder(tx, {
        orderId: params.orderId,
        orderCode: params.orderCode,
        material: params.btpMaterial,
        qty: params.btpQty,
        issuedAt: params.issuedAt,
        issuedBy: params.issuedBy,
      });
    }
    if (params.nvlMaterial) {
      await this.inventory.issueStockForOrder(tx, {
        orderId: params.orderId,
        orderCode: params.orderCode,
        material: params.nvlMaterial,
        qty: params.nvlQty,
        issuedAt: params.issuedAt,
        issuedBy: params.issuedBy,
      });
    }
    if (params.source === ProductionSource.NVL && params.sourceOrderCode) {
      await this.issueFinishedGoodsForOrder(tx, {
        sourceOrderCode: params.sourceOrderCode,
        qty: params.finishedProductQty,
        newOrderId: params.orderId,
        newOrderCode: params.orderCode,
        issuedAt: params.issuedAt,
        issuedBy: params.issuedBy,
        actorId: params.actorId,
      });
    }
  }

  /** Xuất thành phẩm đã chọn vào tab Xuất kho thành phẩm, gắn đơn mới. */
  private async issueFinishedGoodsForOrder(
    tx: Prisma.TransactionClient,
    params: {
      sourceOrderCode: string;
      qty: number;
      newOrderId: string;
      newOrderCode: string;
      issuedAt: Date;
      issuedBy: string;
      actorId: string;
    },
  ) {
    if (params.qty < 1) return;
    const source = await tx.productionOrder.findUnique({
      where: { code: params.sourceOrderCode },
      select: { id: true, qty: true, returnedQty: true, status: true },
    });
    if (!source) {
      throw new BadRequestException(
        `Không tìm thấy mã ${params.sourceOrderCode} trong kho thành phẩm`,
      );
    }
    const last = await tx.shipment.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    const note = `Xuất cho đơn ${params.newOrderCode}`;
    const returnedQty = source.returnedQty + params.qty;
    await tx.shipment.create({
      data: {
        seq,
        code: fgShipmentCode(seq),
        shippedAt: params.issuedAt,
        customerName: '—',
        note,
        createdByUserId: params.actorId,
        createdByName: params.issuedBy,
        autoIssued: true,
        createdByOrderId: params.newOrderId,
        lines: {
          create: {
            orderId: source.id,
            qty: params.qty,
            unitPrice: 0,
            amount: 0,
            unitCost: 0,
            costAmount: 0,
            note,
          },
        },
      },
    });
    await tx.productionOrder.update({
      where: { id: source.id },
      data: {
        returnedQty,
        ...(returnedQty >= source.qty ? { status: S.DELIVERED } : {}),
      },
    });
  }

  private async revokeFinishedGoodsForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ) {
    const rows = await tx.shipment.findMany({
      where: { createdByOrderId: orderId, autoIssued: true },
      select: { id: true, lines: { select: { orderId: true } } },
    });
    if (rows.length === 0) return;
    const sourceIds = rows.flatMap((row) =>
      row.lines.map((line) => line.orderId),
    );
    await tx.shipment.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    await this.touchReturnedQty(tx, sourceIds);
  }

  private async touchReturnedQty(
    tx: Prisma.TransactionClient,
    orderIds: string[],
  ) {
    for (const orderId of new Set(orderIds)) {
      const order = await tx.productionOrder.findUnique({
        where: { id: orderId },
        select: {
          qty: true,
          status: true,
          returnedQty: true,
          shipmentLines: { select: { qty: true } },
        },
      });
      if (!order) continue;
      const shipped = order.shipmentLines.reduce((sum, line) => sum + line.qty, 0);
      const delivered = shipped >= order.qty;
      const nextStatus = delivered
        ? S.DELIVERED
        : order.status === S.DELIVERED
          ? S.FINISHING
          : order.status;
      if (shipped === order.returnedQty && nextStatus === order.status) continue;
      await tx.productionOrder.update({
        where: { id: orderId },
        data: {
          returnedQty: shipped,
          status: nextStatus,
        },
      });
    }
  }

  private async resolveWarehouseMaterial(
    materialId: string,
    warehouseCode: string,
    missing: string,
  ) {
    const material = await this.prisma.material.findFirst({
      where: {
        id: materialId,
        isActive: true,
        warehouse: { code: warehouseCode },
      },
      select: {
        id: true,
        name: true,
        sku: true,
        warehouseId: true,
        unit: { select: { id: true, name: true } },
      },
    });
    if (!material) throw new BadRequestException(missing);
    return material;
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

  /** Giá trị đã từng nhập, dùng làm gợi ý. Đi qua Prisma Client để khỏi lệch schema. */
  private async distinctValues(field: (typeof SUGGEST_FIELDS)[number]) {
    const rows = await this.prisma.productionOrder.findMany({
      where: { [field]: { not: null } },
      distinct: [field],
      select: { closedBy: true, leadTime: true, debtStatus: true },
      take: 200,
    });
    return rows
      .map((row) => row[field])
      .filter((value): value is string => Boolean(value));
  }

  private async usedStoneTypes() {
    const rows = await this.prisma.productionOrder.findMany({
      where: { stoneTypes: { isEmpty: false } },
      select: { stoneTypes: true },
    });
    return rows.flatMap((row) => row.stoneTypes);
  }
}

/** Đơn vừa tạo chưa có khâu / phiếu — đủ để FE vào trang chi tiết ngay, không join thêm. */
function asCreatedDetail(
  row: Prisma.ProductionOrderGetPayload<{
    include: { images: true; statusLogs: true };
  }>,
  btpMaterial: WarehouseMaterial | null,
  nvlMaterial: WarehouseMaterial | null,
  issuedCount = 0,
): OrderDetail {
  return {
    ...row,
    btpMaterial: btpMaterial
      ? { id: btpMaterial.id, sku: btpMaterial.sku, name: btpMaterial.name }
      : null,
    nvlMaterial: nvlMaterial
      ? { id: nvlMaterial.id, sku: nvlMaterial.sku, name: nvlMaterial.name }
      : null,
    stages: [],
    subTickets: [],
    parent: null,
    children: [],
    receipt: null,
    shipmentLines: [],
    _count: { outbounds: issuedCount },
  };
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

function fgShipmentCode(seq: number) {
  return `PX${String(seq).padStart(4, '0')}`;
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
