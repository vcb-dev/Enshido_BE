import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MaterialRequestKind,
  MaterialRequestStatus,
  Prisma,
  ProductionSource,
  ProductionStage,
  ProductionStatus,
  RoleCode,
} from '@prisma/client';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { InventoryService } from '../inventory/inventory.service';
import { dbTable } from '../prisma/database-url';
import { PrismaService } from '../prisma/prisma.service';
import { recordEditLog } from '../edit-logs/edit-log';
import { CloudinaryService } from '../uploads/cloudinary.service';
import { decStr, METAL_KIND_LABEL } from '../util/money';
import { ACTIVITY, activity, entrySnapshot, logActivity } from './activity-log';
import { issuedOf, silverInOf } from './stage-math';
import { InflightMap, TtlCache } from '../util/ttl-cache';
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
  UpsertProductionOrderDto,
  type ProductionNvlLineDto,
} from './dto/production-order.dto';
import {
  actorName,
  decimalOrNull,
  detailInclude,
  entriesOf,
  handedStoneOf,
  IN_STAGE_STATUSES,
  LAST_STAGE,
  lastStageDone,
  normalizeCode,
  orderEntries,
  orderListStatuses,
  orderTicketAvailable,
  orderTicketState,
  type MaterialRequest,
  type OrderDetail,
  requestsOf,
  requireStage,
  STAGE_LABEL,
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

type ResolvedNvlLine = {
  material: WarehouseMaterial;
  qty: number;
  platingColor: string | null;
  stoneWeight: string | null;
  laserEngraving: string | null;
  otherRequirements: string | null;
};

/**
 * Đổi tay được. Đúc đi qua báo Đúc, các khâu đi qua giao thợ, Đã giao đến từ phiếu xuất
 * hàng — để phiếu thợ, kho thành phẩm và hệ thống luôn khớp.
 */
const MANUAL_STATUSES: ProductionStatus[] = [S.NEW, S.REDO_3D, S.DEFECT];

const DEFAULT_LEAD_TIMES = ['3-5 ngày', '7-15 ngày', '15-30 ngày'];

const SUGGEST_FIELDS = [
  'closedBy',
  'leadTime',
  'debtStatus',
  'customerName',
] as const;
const SUGGEST_COLUMNS = {
  closedBy: Prisma.raw('"closed_by"'),
  leadTime: Prisma.raw('"lead_time"'),
  debtStatus: Prisma.raw('"debt_status"'),
  customerName: Prisma.raw('"customer_name"'),
} as const;

const warehouseMaterialSelect = {
  id: true,
  name: true,
  sku: true,
  warehouseId: true,
  unit: { select: { id: true, name: true } },
} as const;

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

    // NOT đứng một mình loại luôn đơn có trackingCode null (NULL LIKE … ra NULL), nên phải
    // giữ null lại bằng OR.
    const base: Prisma.ProductionOrderWhereInput = {
      AND: [
        {
          OR: [
            { trackingCode: null },
            { NOT: { trackingCode: { startsWith: 'KHO-' } } },
          ],
        },
      ],
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
        { btpName: contains },
        { customerName: contains },
      ];
    }
    const orderBy: Prisma.ProductionOrderOrderByWithRelationInput[] =
      sort === 'code' ? [{ seq: dir }] : [{ [sort]: dir }, { seq: 'desc' }];

    // Đơn chưa chia luôn nằm đúng một tab — chính trạng thái của nó — nên lọc và đếm thẳng
    // trong DB. Chỉ đơn đã chia mới nằm được nhiều tab cùng lúc (mỗi phiếu con một khâu),
    // và chỉ nhóm đó mới phải kéo về tính trong bộ nhớ.
    const plainWhere: Prisma.ProductionOrderWhereInput = {
      AND: [base, { subTickets: { none: {} } }],
    };
    const [plainGrouped, splitRows] = await Promise.all([
      this.prisma.productionOrder.groupBy({
        by: ['status'],
        where: plainWhere,
        _count: { _all: true },
      }),
      this.prisma.productionOrder.findMany({
        where: { AND: [base, { subTickets: { some: {} } }] },
        select: {
          id: true,
          status: true,
          subTickets: {
            select: {
              id: true,
              pendingStage: true,
              claimedByUserId: true,
              outcome: true,
            },
          },
          // Vị trí phiếu con chỉ đọc khâu của phiếu con; khâu cấp đơn không liên quan.
          stages: {
            where: { subTicketId: { not: null } },
            orderBy: { createdAt: 'asc' },
            select: {
              subTicketId: true,
              stage: true,
              returnedAt: true,
              submittedAt: true,
            },
          },
        },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(S).map((status) => [status, 0]),
    ) as Record<ProductionStatus, number>;
    let all = 0;
    for (const group of plainGrouped) {
      statusCounts[group.status] += group._count._all;
      all += group._count._all;
    }
    // Id của đơn đã chia theo từng tab — dùng luôn làm bộ lọc để DB cắt trang, khỏi phải
    // tải hết đơn rồi slice trong Node.
    const splitIdsByStatus = new Map<ProductionStatus, string[]>();
    for (const row of splitRows) {
      all += 1;
      for (const status of orderListStatuses(row)) {
        statusCounts[status] += 1;
        const ids = splitIdsByStatus.get(status);
        if (ids) ids.push(row.id);
        else splitIdsByStatus.set(status, [row.id]);
      }
    }

    // Lọc theo tab: đơn chưa chia so bằng status, đơn đã chia so bằng đúng danh sách id vừa
    // tính. Bọc trong AND để không đè mất OR tìm kiếm của `base`.
    const where: Prisma.ProductionOrderWhereInput = query.status
      ? {
          AND: [
            base,
            {
              OR: [
                { status: query.status, subTickets: { none: {} } },
                { id: { in: splitIdsByStatus.get(query.status) ?? [] } },
              ],
            },
          ],
        }
      : base;

    const [rows, total] = await Promise.all([
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
          customerName: true,
          description: true,
          stoneColor: true,
          stoneTypes: true,
          size: true,
          sizeLabel: true,
          mainMaterial: true,
          platingColor: true,
          btpCategory: true,
          btpName: true,
          productKind: true,
          askedUserName: true,
          receivedDate: true,
          dueDate: true,
          debtStatus: true,
          createdAt: true,
          updatedAt: true,
          pendingStage: true,
          claimedByUserId: true,
          receipt: true,
          btpMaterial: { select: { sku: true } },
          // Phiếu con kèm các khâu của chúng — vừa đủ để tính trạng thái từng phiếu cho cột
          // "Phiếu con" ở danh sách, không kéo cả chi tiết đơn.
          subTickets: {
            orderBy: { no: 'asc' },
            select: {
              id: true,
              no: true,
              qty: true,
              note: true,
              createdAt: true,
              pendingStage: true,
              claimedByUserId: true,
              claimedByName: true,
              outcome: true,
            },
          },
          stages: {
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
    ]);

    return {
      total,
      statusCounts: { ...statusCounts, ALL: all },
      items: rows.map((row) => {
        const parentEntries = row.stages.filter((entry) => !entry.subTicketId);
        const parentProgress = row.subTickets.length
          ? null
          : orderTicketState(row, parentEntries);
        const lastParentEntry = parentEntries[parentEntries.length - 1];
        const workStage = parentProgress
          ? (parentProgress.activeStage ?? lastParentEntry?.stage ?? null)
          : null;
        return {
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
          customerName: row.customerName,
          description: row.description,
          stoneColor: row.stoneColor,
          stoneTypes: row.stoneTypes,
          size: row.size,
          sizeLabel: row.sizeLabel,
          mainMaterial: row.mainMaterial,
          platingColor: row.platingColor,
          btpCategory: row.btpCategory,
          btpName: row.btpName,
          productKind: row.productKind,
          askedUserName: row.askedUserName,
          receivedDate: ymd(row.receivedDate),
          dueDate: row.dueDate ? ymd(row.dueDate) : null,
          debtStatus: row.debtStatus,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          workState: workStage ? (parentProgress?.state ?? null) : null,
          workStage,
          images: [],
          subTickets: row.subTickets.map((ticket) =>
            subTicketSummary(
              row.code,
              ticket,
              row.stages.filter((entry) => entry.subTicketId === ticket.id),
            ),
          ),
        };
      }),
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
    const [
      users,
      materialTypes,
      closers,
      usedStoneTypes,
      leadTimes,
      debts,
      customers,
      shipmentCustomers,
    ] = await Promise.all([
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
      this.distinctValues('customerName'),
      this.prisma.shipment.findMany({
        where: { customerName: { not: '' } },
        distinct: ['customerName'],
        select: { customerName: true },
        orderBy: { customerName: 'asc' },
        take: 200,
      }),
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
      customers: uniqueSorted([
        ...customers,
        ...shipmentCustomers.map((row) => row.customerName),
      ]),
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
        otherClass: { select: { name: true, code: true } },
        platingColor: { select: { name: true } },
        color: { select: { name: true } },
        stoneWeight: true,
        weight: true,
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
      categoryCode: row.otherClass?.code ?? null,
      platingColor: row.platingColor?.name ?? null,
      stoneColor: row.color?.name ?? null,
      sizeLabel: row.sizeLabel,
      stoneWeight: row.stoneWeight != null ? decStr(row.stoneWeight) : null,
      weight: row.weight != null ? decStr(row.weight) : null,
      images: row.images,
    }));
  }

  /** Mã thành phẩm trong kho thành phẩm — chọn để điền sẵn form Đơn mới. */
  async finishedProductOptions(search?: string) {
    const keyword = search?.trim();
    const receipts = await this.prisma.finishedGoodsReceipt.findMany({
      where: {
        stockedQty: { gt: 0 },
        ...(keyword
          ? {
              order: {
                OR: [
                  { code: { contains: keyword, mode: 'insensitive' } },
                  { description: { contains: keyword, mode: 'insensitive' } },
                  { btpName: { contains: keyword, mode: 'insensitive' } },
                  { trackingCode: { contains: keyword, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: {
        order: {
          select: {
            code: true,
            description: true,
            btpName: true,
            requestType: true,
            qty: true,
            qtyUnit: true,
            size: true,
            sizeLabel: true,
            mainMaterial: true,
            platingColor: true,
            stoneColor: true,
            stoneTypes: true,
            stoneCount: true,
            stoneWeight: true,
            weight: true,
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
              take: 12,
            },
            shipmentLines: { select: { qty: true } },
            bomLines: {
              orderBy: { sortOrder: 'asc' },
              select: {
                material: {
                  select: {
                    id: true,
                    sku: true,
                    name: true,
                    sizeLabel: true,
                    note: true,
                    metalKind: true,
                    locationCode: true,
                    unit: { select: { name: true } },
                    balance: { select: { qty: true } },
                    materialType: { select: { name: true } },
                    bodyMetal: { select: { name: true } },
                    shape: { select: { name: true } },
                    color: { select: { name: true } },
                    stoneWeight: true,
                    weight: true,
                    images: {
                      select: { url: true },
                      orderBy: { sortOrder: 'asc' },
                      take: 1,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const seen = new Set<string>();
    const items = [];
    for (const receipt of receipts) {
      if (seen.has(receipt.order.code)) continue;
      seen.add(receipt.order.code);
      const shippedQty = receipt.order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      items.push({
        code: receipt.order.code,
        description: receipt.order.description,
        btpName: receipt.order.btpName,
        requestType: receipt.order.requestType,
        qty: receipt.order.qty,
        size: receipt.order.size,
        sizeLabel: receipt.order.sizeLabel,
        mainMaterial: receipt.order.mainMaterial,
        platingColor: receipt.order.platingColor,
        stoneColor: receipt.order.stoneColor,
        stoneTypes: receipt.order.stoneTypes,
        stoneCount: receipt.order.stoneCount,
        stoneWeight:
          receipt.order.stoneWeight != null
            ? decStr(receipt.order.stoneWeight)
            : null,
        weight:
          receipt.order.weight != null ? decStr(receipt.order.weight) : null,
        laserEngraving: receipt.order.laserEngraving,
        otherRequirements: receipt.order.otherRequirements,
        remainingQty: receipt.stockedQty - shippedQty,
        qtyUnit: receipt.order.qtyUnit,
        images: receipt.order.images,
        bomLines: receipt.order.bomLines.map((line) => ({
          id: line.material.id,
          sku: line.material.sku,
          name: line.material.name,
          unit: line.material.unit.name,
          qty: decStr(line.material.balance?.qty),
          locationCode: line.material.locationCode ?? null,
          shape: line.material.shape?.name ?? null,
          color: line.material.color?.name ?? null,
          materialType: line.material.materialType?.name ?? null,
          bodyMetal: line.material.bodyMetal?.name ?? null,
          metalKind: line.material.metalKind
            ? (METAL_KIND_LABEL[line.material.metalKind] ??
              line.material.metalKind)
            : null,
          sizeLabel: line.material.sizeLabel,
          stoneWeight:
            line.material.stoneWeight != null
              ? decStr(line.material.stoneWeight)
              : null,
          weight:
            line.material.weight != null ? decStr(line.material.weight) : null,
          note: line.material.note,
          imageUrl: line.material.images[0]?.url ?? null,
        })),
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
        stoneWeight: true,
        weight: true,
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
      metalKind: row.metalKind
        ? (METAL_KIND_LABEL[row.metalKind] ?? row.metalKind)
        : null,
      sizeLabel: row.sizeLabel,
      stoneWeight: row.stoneWeight != null ? decStr(row.stoneWeight) : null,
      weight: row.weight != null ? decStr(row.weight) : null,
      note: row.note,
      images: row.images,
    }));
  }

  async addCost(code: string, dto: OrderCostDto, actor: AuthUserPayload) {
    const order = await this.requireCostEditable(code);
    const data = {
      name: requireText(dto.name, 'Nhập tên khoản chi phí'),
      amount: new Prisma.Decimal(dto.amount),
      note: dto.note?.trim() || null,
    };
    await this.prisma.runTx(async (tx) => {
      await tx.productionOrderCost.create({
        data: { orderId: order.id, ...data, createdByName: actorName(actor) },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.COST_ADD, {
        orderCode: order.code,
        after: data,
      });
    });
    return { success: true };
  }

  async updateCost(
    code: string,
    costId: string,
    dto: OrderCostDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.requireCostEditable(code);
    const before = await this.requireCost(order.id, costId);
    const data = {
      name: requireText(dto.name, 'Nhập tên khoản chi phí'),
      amount: new Prisma.Decimal(dto.amount),
      note: dto.note?.trim() || null,
    };
    await this.prisma.runTx(async (tx) => {
      await tx.productionOrderCost.update({ where: { id: before.id }, data });
      await logActivity(tx, order.id, actor, ACTIVITY.COST_UPDATE, {
        orderCode: order.code,
        before,
        after: data,
      });
    });
    await recordEditLog(this.prisma, {
      entityType: 'order_cost',
      entityId: costId,
      reason: dto.editReason,
      changedBy: actorName(actor),
    });
    return { success: true };
  }

  async removeCost(code: string, costId: string, actor: AuthUserPayload) {
    const order = await this.requireCostEditable(code);
    const before = await this.requireCost(order.id, costId);
    await this.prisma.runTx(async (tx) => {
      await tx.productionOrderCost.delete({ where: { id: before.id } });
      await logActivity(tx, order.id, actor, ACTIVITY.COST_DELETE, {
        orderCode: order.code,
        before,
      });
    });
    return { success: true };
  }

  private async requireCost(orderId: string, costId: string) {
    const cost = await this.prisma.productionOrderCost.findFirst({
      where: { id: costId, orderId },
      select: { id: true, name: true, amount: true, note: true },
    });
    if (!cost) throw new NotFoundException('Không tìm thấy khoản chi phí');
    return cost;
  }

  /** Sửa tiền công một khâu ngay ở phần chi phí, không phải gỡ KCS nhận lại. */
  async updateStageLabor(
    code: string,
    stageId: string,
    dto: StageLaborDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.requireCostEditable(code);
    const entry = await this.prisma.productionStageEntry.findFirst({
      where: { id: stageId, orderId: order.id },
      select: {
        id: true,
        stage: true,
        attempt: true,
        returnedAt: true,
        laborCost: true,
        subTicket: { select: { no: true } },
      },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy khâu trên đơn');
    if (!entry.returnedAt) {
      throw new BadRequestException(
        'Khâu chưa được KCS nhận lại — tiền công nhập ở bước nhận lại',
      );
    }
    const laborCost = decimalOrNull(dto.laborCost);
    await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        dataChangedAt: new Date(),
        stages: {
          update: { where: { id: entry.id }, data: { laborCost } },
        },
        activityLogs: {
          create: activity(actor, ACTIVITY.STAGE_LABOR, {
            orderCode: order.code,
            subTicketNo: entry.subTicket?.no,
            stage: entry.stage,
            before: { attempt: entry.attempt, laborCost: entry.laborCost },
            after: { attempt: entry.attempt, laborCost },
          }),
        },
      },
    });
    await recordEditLog(this.prisma, {
      entityType: 'stage_labor',
      entityId: entry.id,
      reason: dto.editReason,
      changedBy: actorName(actor),
    });
    return { success: true };
  }

  /** Đơn đã giao hết thì chi phí đã chụp lên phiếu xuất — không sửa nữa. */
  private async requireCostEditable(code: string) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: normalizeCode(code) },
      select: { id: true, code: true, status: true },
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

  /** Nhật ký thao tác của đơn, mới nhất trước. Tìm theo mã nên đơn đã xoá vẫn xem được. */
  async activityLog(code: string) {
    const rows = await this.prisma.productionActivityLog.findMany({
      where: { orderCode: normalizeCode(code) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((row) => ({
      id: row.id,
      subTicketNo: row.subTicketNo,
      stage: row.stage,
      action: row.action,
      actorName: row.actorName,
      before: row.before,
      after: row.after,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    }));
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
    const { btpMaterial, nvlMaterial, nvlLines, btpQty, ...data } = fields;
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
              activityLogs: {
                create: activity(actor, ACTIVITY.ORDER_CREATE, {
                  orderCode: orderCode(seq),
                  after: orderAuditFields(data),
                }),
              },
            },
            include: {
              images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
              statusLogs: { orderBy: { changedAt: 'desc' } },
            },
          });
          if (nvlLines.length) {
            await this.replaceBomLines(tx, row.id, nvlLines);
          } else if (data.sourceOrderCode) {
            await this.copyBomFromSource(tx, row.id, data.sourceOrderCode);
          }
          await this.issueAutoStockForOrder(tx, {
            orderId: row.id,
            orderCode: row.code,
            issuedAt: data.receivedDate,
            issuedBy: changedBy,
            actorId: actor.id,
            source: data.source,
            btpMaterial,
            btpQty: btpQty ?? data.finishedProductQty ?? data.qty,
            nvlIssues: nvlLines.length
              ? nvlLines.map((line) => ({
                  material: line.material,
                  qty: line.qty,
                }))
              : nvlMaterial
                ? [{ material: nvlMaterial, qty: data.stoneCount ?? 0 }]
                : [],
            sourceOrderCode: data.sourceOrderCode,
            finishedProductQty: data.finishedProductQty ?? 0,
          });
          return row;
        });
        await this.touchSiblings([data.parentId], created.id);
        this.logger.log(
          `Đã lên đơn ${created.code} (${Date.now() - started}ms)`,
        );
        return toDetail(
          asCreatedDetail(created, btpMaterial, nvlMaterial, 0, nvlLines),
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
    const { btpMaterial, nvlMaterial, nvlLines, btpQty, ...fields } =
      await this.orderFields(dto, order.id);
    assertCoversSubTickets(order, fields.qty);
    const nextNvlKey = nvlLines.length
      ? nvlLines.map((line) => `${line.material.id}:${line.qty}`).join('|')
      : `${fields.nvlMaterialId ?? ''}:${fields.stoneCount ?? 0}`;
    const prevNvlKey = order.bomLines.length
      ? order.bomLines
          .map((line) => `${line.materialId}:${line.qty ?? 0}`)
          .join('|')
      : `${order.nvlMaterialId ?? ''}:${order.stoneCount ?? 0}`;
    // Đổi loại đơn / mã / số lượng tự xuất thì hoàn phiếu cũ và xuất lại.
    const reissue =
      fields.source !== order.source ||
      fields.sourceOrderCode !== order.sourceOrderCode ||
      (fields.finishedProductQty ?? fields.qty) !==
        (order.finishedProductQty ?? order.qty) ||
      nextNvlKey !== prevNvlKey;
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

    const changes = diffAudit(
      orderAuditFields(order),
      orderAuditFields(fields),
    );
    const imagesChanged =
      removed.length > 0 || images.some((i) => !existing.has(i.publicId));
    const updated = await this.prisma.runTx(async (tx) => {
      if (changes || imagesChanged || nvlLines.length) {
        await logActivity(tx, order.id, actor, ACTIVITY.ORDER_UPDATE, {
          orderCode: order.code,
          before: changes?.before,
          after: {
            ...changes?.after,
            ...(nvlLines.length
              ? {
                  nvlLines: nvlLines.map((line) => ({
                    sku: line.material.sku ?? line.material.name,
                    qty: line.qty,
                  })),
                }
              : null),
          },
          note: imagesChanged ? 'Có đổi ảnh' : null,
        });
      }
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
      await recordEditLog(tx, {
        entityType: 'production_order',
        entityId: order.id,
        reason: dto.editReason,
        changedBy,
      });
      if (nvlLines.length) {
        await this.replaceBomLines(tx, order.id, nvlLines);
      } else if (fields.sourceOrderCode !== order.sourceOrderCode) {
        await tx.productionOrderBomLine.deleteMany({
          where: { orderId: order.id },
        });
        await this.copyBomFromSource(tx, order.id, fields.sourceOrderCode);
      }
      if (reissue) {
        // Phiếu xuất ở bước giao khâu / thợ xin là vật tư đã giao thật, không theo mã trên đơn — giữ nguyên.
        await this.inventory.revokeBtpForOrder(tx, order.id, {
          keepMaterialRequests: true,
        });
        await this.revokeFinishedGoodsForOrder(tx, order.id);
        await this.issueAutoStockForOrder(tx, {
          orderId: order.id,
          orderCode: order.code,
          issuedAt: fields.receivedDate,
          issuedBy: changedBy,
          actorId: actor.id,
          source: fields.source,
          btpMaterial,
          btpQty: btpQty ?? fields.finishedProductQty ?? fields.qty,
          nvlIssues: nvlLines.length
            ? nvlLines.map((line) => ({
                material: line.material,
                qty: line.qty,
              }))
            : nvlMaterial
              ? [{ material: nvlMaterial, qty: fields.stoneCount ?? 0 }]
              : [],
          sourceOrderCode: fields.sourceOrderCode,
          finishedProductQty: fields.finishedProductQty ?? 0,
        });
      }
      return order.id;
    });
    if (reissue) {
      if (order.source === ProductionSource.BTP) this.inventory.bustBtpStock();
      if (nvlMaterial || order.source === ProductionSource.NVL) {
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

  async remove(code: string, actor: AuthUserPayload) {
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
      // Ghi trước khi xoá: nhật ký giữ mã đơn, `orderId` tự về null khi đơn mất.
      await logActivity(tx, order.id, actor, ACTIVITY.ORDER_DELETE, {
        orderCode: order.code,
        before: orderAuditFields(order),
      });
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
    // Đơn ra khỏi khâu thì khâu đang chờ thợ nhận trên phiếu mẹ / phiếu con cũng huỷ theo.
    const pending = order.subTickets.filter((t) => t.pendingStage).length;
    const parentPending = order.pendingStage != null;
    const logNote = [
      note,
      leaveStock ? '(rút khỏi kho thành phẩm)' : null,
      pending > 0 ? `(huỷ ${pending} phiếu con đang chờ nhận khâu)` : null,
      parentPending ? '(huỷ khâu phiếu mẹ đang chờ nhận)' : null,
    ]
      .filter(Boolean)
      .join(' ');

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        status: target,
        dataChangedAt: new Date(),
        ...(parentPending
          ? {
              pendingStage: null,
              pendingAt: null,
              pendingByName: null,
              claimedByUserId: null,
              claimedByName: null,
              claimedAt: null,
            }
          : null),
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
        activityLogs: {
          create: activity(actor, ACTIVITY.ORDER_STATUS, {
            orderCode: order.code,
            before: { status: order.status },
            after: { status: target },
            note: logNote || null,
          }),
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
    // Báo Đúc lần đầu hoặc đúc lại sau lỗi thì đơn chuyển sang Đúc.
    const toCasting = (
      [S.NEW, S.REDO_3D, S.DEFECT] as ProductionStatus[]
    ).includes(order.status);

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        castingSentDate: sentDate,
        castingReturnedDate: returnedDate,
        dataChangedAt: new Date(),
        activityLogs: {
          create: activity(actor, ACTIVITY.ORDER_CASTING, {
            orderCode: order.code,
            before: {
              status: order.status,
              castingSentDate: ymdOrNull(order.castingSentDate),
              castingReturnedDate: ymdOrNull(order.castingReturnedDate),
            },
            after: {
              status: toCasting ? S.CASTING : order.status,
              castingSentDate: ymd(sentDate),
              castingReturnedDate: ymdOrNull(returnedDate),
            },
          }),
        },
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

  /** Sửa thông tin giao khi KCS chưa nhận lại. Người giao giữ nguyên. */
  async updateHandover(
    code: string,
    stageId: string,
    dto: HandoverStageDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.requireOrder(code);
    const entry = requireStage(order, stageId);
    if (entry.returnedAt) {
      throw new BadRequestException('KCS đã nhận lại khâu này, không sửa được');
    }
    // NVL xuất lúc giao đã thành phiếu xuất kho — sửa thông tin giao không thêm / bớt được.
    if (dto.materials?.length) {
      throw new BadRequestException(
        'NVL đã xuất lúc giao không sửa ở đây — thiếu thì thợ xin xuất thêm',
      );
    }
    // Cả phiếu mẹ và phiếu con đều giữ nguyên người đã tự nhận khâu.
    if (dto.craftsmanUserId !== entry.craftsmanUserId) {
      throw new BadRequestException(
        'Thợ do người nhận phiếu quyết định, chỉ sửa được thời gian, số lượng và trọng lượng giao',
      );
    }
    const craftsman = await this.resolveUser(dto.craftsmanUserId);
    const next = {
      craftsmanUserId: craftsman.id,
      craftsmanName: craftsman.name,
      handedAt: new Date(dto.handedAt),
      handedQty:
        dto.handedQty ?? (entry.subTicketId ? entry.handedQty : order.qty),
      handedSilverWeight:
        dto.handedSilverWeight != null && dto.handedSilverWeight !== ''
          ? new Prisma.Decimal(dto.handedSilverWeight)
          : entry.handedSilverWeight,
      ...handedStoneOf(entry.stage, dto, order, entry.id),
      note: dto.note?.trim() || null,
    };

    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        dataChangedAt: new Date(),
        stages: { update: { where: { id: entry.id }, data: next } },
        activityLogs: {
          create: activity(actor, ACTIVITY.STAGE_HANDOVER_EDIT, {
            orderCode: order.code,
            subTicketNo: ticketNoOf(order, entry.subTicketId),
            stage: entry.stage,
            before: entrySnapshot(entry),
            after: {
              attempt: entry.attempt,
              ...next,
              craftsmanUserId: undefined,
            },
          }),
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
    // Cả phiếu mẹ và phiếu con đều theo cùng luồng: thợ báo xong rồi KCS mới nhận lại.
    if (!entry.submittedAt) {
      throw new BadRequestException(
        'Thợ chưa báo làm xong khâu này — chờ thợ bấm "Đã làm xong" rồi KCS mới nhận lại',
      );
    }
    const requests = requestsOf(order, entry.id);
    const pending = requests.filter(
      (request) => request.status === MaterialRequestStatus.PENDING,
    ).length;
    if (pending > 0) {
      throw new BadRequestException(
        `Còn ${pending} yêu cầu xuất NVL của khâu này chưa xử lý — xuất hoặc từ chối trước khi KCS nhận lại`,
      );
    }
    const issued = issuedOf(requests);
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
    const returnedSilver = new Prisma.Decimal(dto.returnedSilverWeight);
    const btpRecovered = decimalOrNull(dto.btpRecoveredWeight);
    const silverRecovered = decimalOrNull(dto.silverRecoveredWeight);
    // Đá chỉ gắn ở khâu Vào đá; khâu khác gửi lên là sai luồng.
    const isStoneStage = entry.stage === ProductionStage.STONE_SETTING;
    if (
      !isStoneStage &&
      (dto.stoneCount != null ||
        dto.stoneWeight != null ||
        dto.returnedStoneCount != null)
    ) {
      throw new BadRequestException(
        `Chỉ khâu ${STAGE_LABEL[ProductionStage.STONE_SETTING]} mới ghi đá gắn thêm`,
      );
    }
    // Đá phát cho thợ = đá giao lúc nhận việc + đá xuất thêm theo yêu cầu.
    const stonesHanded =
      entry.handedStoneCount != null || issued.stones > 0
        ? (entry.handedStoneCount ?? 0) + issued.stones
        : null;
    const stoneWeightHanded = stoneWeightHandedOf(entry, requests);
    // Sau khâu Vào đá, đá và bạc đã thành một BTP — KCS chỉ cân lại cả cụm, không tách đá.
    // Không gửi số đá gắn thì coi như gắn hết số đã phát để mốc cân vẫn là bạc giao + đá.
    const returnedStoneCount = isStoneStage
      ? (dto.returnedStoneCount ?? null)
      : null;
    const stoneCount = isStoneStage
      ? (dto.stoneCount ??
        (stonesHanded != null
          ? Math.max(0, stonesHanded - (returnedStoneCount ?? 0))
          : null))
      : null;
    const stoneWeight = isStoneStage
      ? (decimalOrNull(dto.stoneWeight) ?? stoneWeightHanded)
      : null;
    // Gắn lên + trả lại nhiều nhất bằng số đá đã phát; phần thiếu là đá mất.
    if (
      stonesHanded != null &&
      (stoneCount ?? 0) + (returnedStoneCount ?? 0) > stonesHanded
    ) {
      throw new BadRequestException(
        `Đá gắn cộng đá trả lại không được nhiều hơn số đá đã phát (${stonesHanded} viên)`,
      );
    }
    if (
      stoneWeightHanded != null &&
      stoneWeight != null &&
      stoneWeight.gt(stoneWeightHanded)
    ) {
      throw new BadRequestException(
        `Trọng lượng đá gắn không được nhiều hơn TL đá đã phát (${decStr(stoneWeightHanded)} g)`,
      );
    }
    // Hàng về không thể nặng hơn hàng giao — chặn ở đây để hao hụt không bao giờ âm.
    // Mốc = bạc vào khâu (giao + xuất thêm); khâu Vào đá cân cả cụm nên cộng TL đá vừa gắn.
    const silverIn = silverInOf(entry, issued.metal);
    if (silverIn != null) {
      const zero = new Prisma.Decimal(0);
      const limit = silverIn.add(stoneWeight ?? zero);
      const label = isStoneStage
        ? 'bạc vào khâu cộng đá'
        : 'bạc vào khâu (giao + xuất thêm)';
      if (returnedSilver.gt(limit)) {
        throw new BadRequestException(
          `Trọng lượng nhận lại không được nhiều hơn ${label} (${decStr(limit)} g)`,
        );
      }
      const back = returnedSilver
        .add(btpRecovered ?? zero)
        .add(silverRecovered ?? zero);
      if (back.gt(limit)) {
        throw new BadRequestException(
          `Nhận lại cộng thu hồi không được nhiều hơn ${label} (${decStr(limit)} g)`,
        );
      }
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
              returnedSilverWeight: returnedSilver,
              stoneCount,
              stoneWeight,
              returnedStoneCount,
              btpRecoveredWeight: btpRecovered,
              silverRecoveredWeight: silverRecovered,
              laborCost: decimalOrNull(dto.laborCost),
              // Ghi chú lúc nhận lại nối vào ghi chú lúc giao, không ghi đè.
              note: joinNotes(entry.note, dto.note),
            },
          },
        },
        activityLogs: {
          create: activity(actor, ACTIVITY.STAGE_RETURN, {
            orderCode: order.code,
            subTicketNo: ticketNoOf(order, entry.subTicketId),
            stage: entry.stage,
            after: {
              attempt: entry.attempt,
              returnedAt,
              returnedQty,
              returnedSilverWeight: returnedSilver,
              stoneCount,
              stoneWeight,
              returnedStoneCount,
              btpRecoveredWeight: btpRecovered,
              silverRecoveredWeight: silverRecovered,
              laborCost: decimalOrNull(dto.laborCost),
            },
            note: dto.note,
          }),
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  /**
   * Kết phiếu ở nhánh Hoàn thiện (thay cho khâu Ngoại Quan cũ): KCS chốt hàng đạt,
   * đơn sang Hoàn thiện và tạo phiếu chờ kho thành phẩm xác nhận nhập.
   */
  async finish(code: string, dto: FinishOrderDto, actor: AuthUserPayload) {
    const order = await this.requireOrder(code);
    if (order.status === S.DELIVERED) {
      throw new BadRequestException('Đơn đã giao');
    }
    if (order.receipt) {
      throw new BadRequestException(
        'Đơn đã hoàn thiện, đã có phiếu chờ nhập thành phẩm',
      );
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
    if (order.pendingStage) {
      throw new BadRequestException(
        `Phiếu mẹ đang mở khâu ${STAGE_LABEL[order.pendingStage]} — huỷ mở khâu trước khi hoàn thiện`,
      );
    }
    const pending = order.subTickets.find((t) => t.pendingStage);
    if (pending?.pendingStage) {
      throw new BadRequestException(
        `Phiếu ${subTicketCode(order.code, pending.no)} đang mở khâu ${STAGE_LABEL[pending.pendingStage]} — huỷ mở khâu trước khi hoàn thiện`,
      );
    }
    const entries = orderEntries(order);
    if (!lastStageDone(entries)) {
      throw new BadRequestException(
        `Đơn chưa xong khâu ${STAGE_LABEL[LAST_STAGE]} — làm hết phiếu rồi mới hoàn thiện được`,
      );
    }
    // Vào kho là số KCS thật sự nhận lại ở khâu cuối, không phải số đặt hàng — giống hệt
    // cách phiếu con chốt bằng `subTicketAvailable`. Hàng hỏng dọc đường không được lên tồn.
    const finishedQty = orderTicketAvailable(order, entries).qty;
    if (finishedQty <= 0) {
      throw new BadRequestException(
        'Khâu cuối không nhận lại được sản phẩm nào — chuyển đơn sang Sản xuất lỗi',
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
            qty: finishedQty,
            stockedQty: 0,
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
        activityLogs: {
          create: activity(actor, ACTIVITY.ORDER_FINISH, {
            orderCode: order.code,
            before: { status: order.status },
            after: { status: S.FINISHING, qty: finishedQty, finishedAt },
            note: dto.note,
          }),
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
        activityLogs: {
          create: activity(actor, ACTIVITY.ORDER_UNDO_FINISH, {
            orderCode: order.code,
            before: {
              status: order.status,
              qty: order.receipt.qty,
              receivedByName: order.receipt.receivedByName,
            },
            after: { status: back },
          }),
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
              stoneCount: null,
              stoneWeight: null,
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
        activityLogs: {
          create: activity(actor, ACTIVITY.STAGE_UNDO_RETURN, {
            orderCode: order.code,
            subTicketNo: ticketNoOf(order, entry.subTicketId),
            stage: entry.stage,
            before: entrySnapshot(entry),
          }),
        },
      },
      include: detailInclude,
    });
    return toDetail(updated);
  }

  async markPrinted(code: string, actor: AuthUserPayload) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: normalizeCode(code) },
      select: { id: true, code: true, source: true, castingSentDate: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    // Đơn BTP lấy hàng đúc sẵn nên in được ngay.
    if (order.source === ProductionSource.NVL && !order.castingSentDate) {
      throw new BadRequestException('Chỉ in phiếu thợ khi đơn đã báo Đúc');
    }
    const updated = await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        lastPrintedAt: new Date(),
        activityLogs: {
          create: activity(actor, ACTIVITY.ORDER_PRINT, {
            orderCode: order.code,
          }),
        },
      },
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
    let trackingCode = dto.trackingCode?.trim() ?? '';
    const leadTime = optional(dto.leadTime);
    const receivedDate = dateOnly(dto.receivedDate);
    if (!dto.dueDate) throw new BadRequestException('Nhập ngày cần trả');
    const dueDate = dateOnly(dto.dueDate);
    if (!selfId && dueDate < dateOnly(todayYmdVn())) {
      throw new BadRequestException('Ngày cần trả không được ở quá khứ');
    }
    if (dueDate < receivedDate) {
      throw new BadRequestException(
        'Ngày cần trả không được trước ngày đặt đơn',
      );
    }

    const askedUserId = dto.askedUserId;
    const parentCode = dto.parentCode?.trim();
    const nvlLines = await this.resolveNvlLines(dto.nvlLines);
    const [asked, parent, btpMaterial, nvlMaterial, sourceOrderCode] =
      await Promise.all([
        askedUserId ? this.resolveUser(askedUserId) : Promise.resolve(null),
        parentCode
          ? this.prisma.productionOrder.findUnique({
              where: { code: normalizeCode(parentCode) },
              select: { id: true, parentId: true },
            })
          : Promise.resolve(null),
        dto.btpMaterialId
          ? this.resolveBtpMaterial(dto.btpMaterialId)
          : Promise.resolve(null),
        nvlLines[0]
          ? Promise.resolve(nvlLines[0].material)
          : dto.nvlMaterialId
            ? this.resolveNvlMaterial(dto.nvlMaterialId)
            : Promise.resolve(null),
        dto.source === ProductionSource.NVL
          ? Promise.resolve(null)
          : this.resolveSourceFinishedProduct(
              dto.finishedProductCode,
              dto.finishedProductQty ?? 0,
            ),
      ]);

    if (dto.source === ProductionSource.NVL) {
      if (!btpMaterial) throw new BadRequestException('Chọn mã sản phẩm');
      if (!dto.model3dCode?.trim()) {
        throw new BadRequestException('Nhập mã sản xuất');
      }
      if (!(dto.finishedProductQty && dto.finishedProductQty >= 1)) {
        throw new BadRequestException('Nhập số lượng thành phẩm cần lên đơn');
      }
      trackingCode = btpMaterial.sku?.trim() || trackingCode;
      if (!trackingCode)
        throw new BadRequestException('Mã sản phẩm không hợp lệ');
    } else if (dto.source === ProductionSource.BTP) {
      if (!btpMaterial) throw new BadRequestException('Chọn mã sản phẩm');
      trackingCode = btpMaterial.sku?.trim() || trackingCode;
      if (!trackingCode)
        throw new BadRequestException('Mã sản phẩm không hợp lệ');
    } else if (!nvlLines.length && !(dto.stoneCount && dto.stoneCount >= 1)) {
      throw new BadRequestException('Nhập số lượng NVL cần lên đơn');
    }

    if (
      dto.source === ProductionSource.BTP &&
      !(dto.finishedProductQty && dto.finishedProductQty >= 1)
    ) {
      throw new BadRequestException('Nhập số lượng thành phẩm cần lên đơn');
    }
    const btpQty =
      dto.source === ProductionSource.BTP
        ? (dto.finishedProductQty ?? dto.qty ?? null)
        : null;

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
      nvlLines,
      btpQty,
      requestType: dto.requestType,
      receivedDate,
      dueDate,
      closedBy,
      customerName: optional(dto.customerName),
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
      stoneCount: nvlLines[0]?.qty ?? dto.stoneCount ?? null,
      stoneWeight: decimalOrNull(nvlLines[0]?.stoneWeight ?? dto.stoneWeight),
      weight: decimalOrNull(dto.weight),
      size: optional(dto.size),
      sizeLabel: optional(dto.sizeLabel),
      mainMaterial: optional(dto.mainMaterial),
      platingColor: optional(nvlLines[0]?.platingColor ?? dto.platingColor),
      btpCategory: optional(dto.btpCategory),
      btpName: optional(dto.btpName) ?? optional(btpMaterial?.name),
      productKind: optional(dto.productKind),
      laserEngraving: optional(
        nvlLines[0]?.laserEngraving ?? dto.laserEngraving,
      ),
      otherRequirements: optional(
        nvlLines[0]?.otherRequirements ?? dto.otherRequirements,
      ),
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
  ) {
    if (!code?.trim())
      throw new BadRequestException('Chọn mã thành phẩm cho Đơn mới');
    if (qty < 1)
      throw new BadRequestException('Nhập số lượng thành phẩm cần lên đơn');
    const orderCode = normalizeCode(code);
    const source = await this.prisma.productionOrder.findUnique({
      where: { code: orderCode },
      select: { code: true, receipt: { select: { id: true } } },
    });
    if (!source?.receipt) {
      throw new BadRequestException(
        `Không tìm thấy mã ${orderCode} trong kho thành phẩm`,
      );
    }
    return source.code;
  }

  /** Ghi BOM NVL của đơn kèm số lượng / xi / khắc từng dòng. */
  private async replaceBomLines(
    tx: Prisma.TransactionClient,
    orderId: string,
    lines: ResolvedNvlLine[],
  ) {
    await tx.productionOrderBomLine.deleteMany({ where: { orderId } });
    if (!lines.length) return;
    await tx.productionOrderBomLine.createMany({
      data: lines.map((line, index) => ({
        id: randomUUID(),
        orderId,
        materialId: line.material.id,
        sortOrder: index,
        platingColor: line.platingColor,
        qty: line.qty,
        stoneWeight: decimalOrNull(line.stoneWeight),
        laserEngraving: line.laserEngraving,
        otherRequirements: line.otherRequirements,
      })),
    });
  }

  private async resolveNvlLines(
    lines?: ProductionNvlLineDto[],
  ): Promise<ResolvedNvlLine[]> {
    if (!lines?.length) return [];
    const ids = lines.map((line) => line.materialId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Mã NVL bị trùng trên đơn');
    }
    const materials = await this.resolveWarehouseMaterials(
      ids,
      NVL_WAREHOUSE_CODE,
      'Không tìm thấy mã NVL trong kho NVL chính',
    );
    return lines.map((line) => ({
      material: materials.get(line.materialId)!,
      qty: line.qty,
      platingColor: optional(line.platingColor),
      stoneWeight: line.stoneWeight ?? null,
      laserEngraving: optional(line.laserEngraving),
      otherRequirements: optional(line.otherRequirements),
    }));
  }

  /** Chép BOM NVL từ thành phẩm nguồn sang đơn mới. */
  private async copyBomFromSource(
    tx: Prisma.TransactionClient,
    orderId: string,
    sourceOrderCode: string | null | undefined,
  ) {
    if (!sourceOrderCode) return;
    const source = await tx.productionOrder.findUnique({
      where: { code: sourceOrderCode },
      select: {
        bomLines: {
          select: { materialId: true, sortOrder: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!source?.bomLines.length) return;
    await tx.productionOrderBomLine.createMany({
      data: source.bomLines.map((line) => ({
        id: randomUUID(),
        orderId,
        materialId: line.materialId,
        sortOrder: line.sortOrder,
      })),
    });
  }

  /**
   * Xuất kho gắn đơn lúc lên / sửa đơn: chỉ còn xuất thành phẩm nguồn cho Đơn NVL mới. Không
   * xuất BTP, NVL hay đá — các thứ đó xuất ở bước giao khâu Nguội / Vào đá.
   */
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
      btpQty: number;
      nvlIssues: Array<{ material: WarehouseMaterial; qty: number }>;
      sourceOrderCode: string | null;
      finishedProductQty: number;
    },
  ) {
    // Lên đơn không xuất NVL / đá (người dùng chốt 2026-09-25): đá chỉ xuất ở khâu Vào đá,
    // phôi chỉ xuất ở khâu Nguội — xem ProductionMaterialRequestsService.issueAtHandover.
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
      const shipped = order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      const delivered = shipped >= order.qty;
      const nextStatus = delivered
        ? S.DELIVERED
        : order.status === S.DELIVERED
          ? S.FINISHING
          : order.status;
      if (shipped === order.returnedQty && nextStatus === order.status)
        continue;
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
      select: warehouseMaterialSelect,
    });
    if (!material) throw new BadRequestException(missing);
    return material;
  }

  private async resolveWarehouseMaterials(
    materialIds: string[],
    warehouseCode: string,
    missing: string,
  ) {
    const rows = await this.prisma.material.findMany({
      where: {
        id: { in: materialIds },
        isActive: true,
        warehouse: { code: warehouseCode },
      },
      select: warehouseMaterialSelect,
    });
    if (rows.length !== materialIds.length) {
      throw new BadRequestException(missing);
    }
    return new Map(rows.map((row) => [row.id, row]));
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

  /** Giá trị đã từng nhập, dùng làm gợi ý. DISTINCT trên cột thay vì quét cả bảng. */
  private async distinctValues(field: (typeof SUGGEST_FIELDS)[number]) {
    const column = SUGGEST_COLUMNS[field];
    const rows = await this.prisma.$queryRaw<Array<{ value: string }>>`
      SELECT DISTINCT ${column} AS value
      FROM ${dbTable('production_orders')}
      WHERE ${column} IS NOT NULL AND ${column} <> ''
      LIMIT 200
    `;
    return rows.map((row) => row.value);
  }

  private async usedStoneTypes() {
    const rows = await this.prisma.$queryRaw<Array<{ stone_type: string }>>`
      SELECT DISTINCT unnest(stone_types) AS stone_type
      FROM ${dbTable('production_orders')}
      WHERE cardinality(stone_types) > 0
      LIMIT 200
    `;
    return rows.map((row) => row.stone_type).filter(Boolean);
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
  nvlLines: ResolvedNvlLine[] = [],
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
    materialRequests: [],
    parent: null,
    children: [],
    receipt: null,
    shipmentLines: [],
    bomLines: nvlLines.map((line) => ({
      materialId: line.material.id,
      material: { sku: line.material.sku, name: line.material.name },
      platingColor: line.platingColor,
      qty: line.qty,
      stoneWeight: decimalOrNull(line.stoneWeight),
      laserEngraving: line.laserEngraving,
      otherRequirements: line.otherRequirements,
    })),
    _count: { outbounds: issuedCount },
  };
}

function lastStage(order: OrderDetail): StageEntry | undefined {
  return order.stages[order.stages.length - 1];
}

/** Số lượng đơn không được nhỏ hơn phần đã chia cho phiếu con. */
function assertCoversSubTickets(order: OrderDetail, qty: number) {
  if (order.subTickets.length === 0) return;
  const splitQty = order.subTickets.reduce((sum, t) => sum + t.qty, 0);
  if (qty < splitQty) {
    throw new BadRequestException(
      `Số lượng đơn không được nhỏ hơn tổng số lượng đã chia phiếu con (${splitQty})`,
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

function todayYmdVn() {
  const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return vn.toISOString().slice(0, 10);
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Các trường đơn đưa vào nhật ký khi tạo / sửa / xoá — bỏ ảnh và quan hệ. */
const AUDIT_FIELDS = [
  'source',
  'btpMaterialId',
  'nvlMaterialId',
  'sourceOrderCode',
  'requestType',
  'receivedDate',
  'dueDate',
  'closedBy',
  'description',
  'qty',
  'qtyUnit',
  'finishedProductQty',
  'model3dCode',
  'model3dUrl',
  'trackingCode',
  'stoneColor',
  'stoneTypes',
  'stoneCount',
  'stoneWeight',
  'size',
  'sizeLabel',
  'laserEngraving',
  'otherRequirements',
  'mainMaterial',
  'platingColor',
  'btpCategory',
  'productKind',
  'parentId',
  'debtStatus',
] as const;

function orderAuditFields(source: Partial<Record<string, unknown>>) {
  const picked: Record<string, unknown> = {};
  for (const key of AUDIT_FIELDS) {
    if (!(key in source)) continue;
    const value = source[key];
    picked[key] = value instanceof Date ? ymd(value) : value;
  }
  return picked;
}

/** Chỉ giữ các trường đổi giá trị; không đổi gì thì null. */
function diffAudit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const changed = Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  if (!changed.length) return null;
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  };
}

function ymdOrNull(value: Date | null) {
  return value ? ymd(value) : null;
}

function ticketNoOf(
  order: { subTickets: { id: string; no: number }[] },
  subTicketId: string | null,
) {
  return (
    order.subTickets.find((ticket) => ticket.id === subTicketId)?.no ?? null
  );
}

/**
 * TL đá phát cho thợ ở khâu (g) = TL đá giao lúc nhận việc + TL đá xuất thêm (lần xuất nào
 * có cân). Không có số nào thì null — không chặn TL đá gắn.
 */
function stoneWeightHandedOf(
  entry: StageEntry,
  requests: readonly MaterialRequest[],
) {
  const weighed = requests.filter(
    (request) =>
      request.status === MaterialRequestStatus.ISSUED &&
      request.kind === MaterialRequestKind.STONE &&
      request.issuedWeight != null,
  );
  if (entry.handedStoneWeight == null && weighed.length === 0) return null;
  return weighed.reduce(
    (sum, request) => sum.add(request.issuedWeight!),
    entry.handedStoneWeight ?? new Prisma.Decimal(0),
  );
}
