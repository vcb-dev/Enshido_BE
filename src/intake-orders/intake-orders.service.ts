import { intakeListSelect, toIntakeRow } from './intake-order-row';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IntakeOrderStatus,
  Prisma,
  ProductionImageKind,
  ProductionSource,
  ProductionStatus,
} from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { recordEditLog } from '../edit-logs/edit-log';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../uploads/cloudinary.service';
import {
  ApproveIntakeOrderDto,
  ConfirmWarehouseDto,
  WaxPrintBatchDto,
  RejectIntakeOrderDto,
  IntakeModel3dDto,
  IntakeCastingTreeSpecsDto,
  IntakeProductSpecsDto,
  IntakeOrderImageDto,
  IntakeWaxPrintBatchDto,
  ListIntakeOrdersQuery,
  UpsertIntakeOrderDto,
} from './dto/intake-order.dto';
import { Permission, userCan } from '../auth/permissions';
import { canConfirmIntakeWarehouse } from './intake-warehouse-access';
import {
  INTAKE_ORDER_WHERE,
  intakeCode,
  intakeStatusWhere,
  nextIntakeSeq,
  nextOrderSeq,
  orderCode,
  randomSxCode,
  toIntakeStatus,
} from '../production-orders/intake-order';

export { intakeCode, randomSxCode };

const CREATE_RETRIES = 5;

function parseDate(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${label} không hợp lệ`);
  }
  return date;
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

const INTAKE_PIPELINE_STATUSES: IntakeOrderStatus[] = [
  IntakeOrderStatus.PENDING_APPROVAL,
  IntakeOrderStatus.APPROVED,
  IntakeOrderStatus.READY_FOR_PRODUCTION,
  IntakeOrderStatus.PENDING_WAREHOUSE_CONFIRMATION,
  IntakeOrderStatus.WAX_PRINTED,
  IntakeOrderStatus.WAX_CONFIRMED,
  IntakeOrderStatus.WAIT_CASTING,
  IntakeOrderStatus.CASTING,
  IntakeOrderStatus.CAST_PENDING_CONFIRMATION,
  IntakeOrderStatus.CAST_DONE,
  IntakeOrderStatus.WAIT_COOLING,
];

function intakeListWhere(
  query: Pick<
    ListIntakeOrdersQuery,
    'search' | 'requestType' | 'status' | 'unlinkedOnly' | 'rootsOnly'
  >,
): Prisma.ProductionOrderWhereInput {
  const keyword = query.search?.trim();
  return {
    AND: [
      INTAKE_ORDER_WHERE,
      ...(query.rootsOnly ? [{ reworkOfOrderId: null }] : []),
      ...(query.status ? [intakeStatusWhere(query.status)] : []),
      // Chưa cắt cây = chưa sang lệnh sản xuất (Nguội).
      ...(query.unlinkedOnly ? [{ cutAt: null }] : []),
      ...(query.requestType ? [{ requestType: query.requestType }] : []),
      ...(keyword
        ? [
            {
              OR: [
                {
                  intakeCode: {
                    contains: keyword,
                    mode: 'insensitive' as const,
                  },
                },
                { sxCode: { contains: keyword, mode: 'insensitive' as const } },
                {
                  trackingCode: {
                    contains: keyword,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  closedBy: { contains: keyword, mode: 'insensitive' as const },
                },
                {
                  description: {
                    contains: keyword,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  productName: {
                    contains: keyword,
                    mode: 'insensitive' as const,
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
}

/** Gom đếm theo trạng thái kiểu đơn tạo (đơn đã cắt cây gộp vào WAIT_COOLING). */
function countByIntakeStatus(
  rows: {
    status: ProductionStatus;
    cutAt: Date | null;
    _count: { _all: number };
  }[],
) {
  const counts = Object.fromEntries(
    INTAKE_PIPELINE_STATUSES.map((status) => [status, 0]),
  ) as Record<IntakeOrderStatus, number>;
  for (const row of rows) {
    const status = toIntakeStatus(row);
    if (status in counts) counts[status] += row._count._all;
  }
  return counts;
}

@Injectable()
export class IntakeOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async list(query: ListIntakeOrdersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where = intakeListWhere(query);
    const [total, rows] = await Promise.all([
      this.prisma.productionOrder.count({ where }),
      this.prisma.productionOrder.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: intakeListSelect,
      }),
    ]);
    return { items: rows.map(toIntakeRow), total, page, pageSize };
  }

  /** Một lần đếm cho badge tab Lệnh sản xuất — tránh N request count riêng lẻ trên FE. */
  async pipelineStatusCounts() {
    const rows = await this.prisma.productionOrder.groupBy({
      by: ['status', 'cutAt'],
      where: intakeListWhere({ unlinkedOnly: true }),
      _count: { _all: true },
    });
    return countByIntakeStatus(rows);
  }

  /**
   * Tab Tất cả — 1 groupBy + 1 findMany (không N query theo từng trạng thái).
   */
  async pipelineLists(
    query: Pick<
      ListIntakeOrdersQuery,
      'search' | 'requestType' | 'pageSize' | 'rootsOnly'
    >,
  ) {
    const pageSize = Math.min(query.pageSize ?? 200, 400);
    const where = intakeListWhere({
      ...query,
      status: undefined,
      unlinkedOnly: true,
    });
    const [countRows, rows] = await Promise.all([
      this.prisma.productionOrder.groupBy({
        by: ['status', 'cutAt'],
        where,
        _count: { _all: true },
      }),
      this.prisma.productionOrder.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        take: pageSize,
        select: intakeListSelect,
      }),
    ]);
    const counts = countByIntakeStatus(countRows);
    const itemsByStatus = Object.fromEntries(
      INTAKE_PIPELINE_STATUSES.map((status) => [
        status,
        [] as ReturnType<typeof toIntakeRow>[],
      ]),
    ) as Record<IntakeOrderStatus, ReturnType<typeof toIntakeRow>[]>;
    for (const row of rows) {
      itemsByStatus[toIntakeStatus(row)]?.push(toIntakeRow(row));
    }
    return Object.fromEntries(
      INTAKE_PIPELINE_STATUSES.map((status) => [
        status,
        {
          items: itemsByStatus[status],
          total: counts[status] ?? 0,
          page: 1,
          pageSize,
        },
      ]),
    ) as Record<
      IntakeOrderStatus,
      Awaited<ReturnType<IntakeOrdersService['list']>>
    >;
  }

  async create(dto: UpsertIntakeOrderDto, actor: AuthUserPayload) {
    const data = this.fields(dto);
    const placedBy = actor.fullName?.trim() || actor.username;
    const images = this.newImages(dto.images, new Set());

    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.prisma.runTx(async (tx) => {
          // Mã A… (lệnh sản xuất) và DH… (đơn hàng) cùng cấp ngay lúc tạo đơn.
          const seq = await nextOrderSeq(tx);
          const intakeSeq = await nextIntakeSeq(tx);
          return tx.productionOrder.create({
            data: {
              ...data,
              seq,
              code: orderCode(seq),
              intakeSeq,
              intakeCode: intakeCode(intakeSeq),
              sxCode: randomSxCode(),
              source: ProductionSource.NVL,
              closedBy: placedBy,
              createdBy: placedBy,
              createdByUserId: actor.id,
              status: ProductionStatus.PENDING_APPROVAL,
              images: { create: images },
            },
            include: {
              images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
            },
          });
        });
        return toIntakeRow(created);
      } catch (error) {
        if (isUniqueViolation(error) && attempt < CREATE_RETRIES) continue;
        throw error;
      }
    }
  }

  async update(id: string, dto: UpsertIntakeOrderDto, actor: AuthUserPayload) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    // Trạng thái chỉ đổi qua đúng thao tác của từng bước (duyệt, gắn 3D, cân sáp, thủ kho
    // xác nhận, phiếu đúc). Sửa đơn chỉ sửa thông tin, không nhảy bước được.
    if (dto.status !== undefined && dto.status !== toIntakeStatus(order)) {
      throw new BadRequestException(
        'Không đổi trạng thái ở form sửa đơn — dùng nút thao tác của bước tương ứng',
      );
    }

    const { receivedDate: _created, ...data } = this.fields(dto);
    const existing = new Set(order.images.map((image) => image.publicId));
    const images = this.newImages(dto.images, existing);
    const kept = new Set(images.map((image) => image.publicId));
    const removed = order.images
      .map((image) => image.publicId)
      .filter((publicId) => !kept.has(publicId));

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id },
        data: {
          ...data,
          images: { deleteMany: {}, create: images },
        },
      });
      await recordEditLog(tx, {
        entityType: 'intake_order_form',
        entityId: id,
        reason: dto.editReason,
        changedBy: actor.fullName?.trim() || actor.username,
      });
      return tx.productionOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    await this.cloudinary.destroy(removed);
    return toIntakeRow(updated);
  }

  async approve(
    id: string,
    dto: ApproveIntakeOrderDto,
    _actor: AuthUserPayload,
  ) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== ProductionStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Chỉ duyệt được đơn đang chờ duyệt');
    }

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id },
        data: {
          hasMold: dto.hasMold,
          status: dto.hasMold
            ? ProductionStatus.READY_FOR_PRODUCTION
            : ProductionStatus.APPROVED,
        },
      });
      return tx.productionOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toIntakeRow(updated);
  }

  async reject(id: string, dto: RejectIntakeOrderDto, actor: AuthUserPayload) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== ProductionStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Chỉ từ chối được đơn đang chờ duyệt');
    }

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id },
        data: {
          status: ProductionStatus.REJECTED,
          hasMold: null,
          rejectReason: dto.reason?.trim() || null,
          rejectedByName: actor.fullName?.trim() || actor.username,
          rejectedAt: new Date(),
        },
      });
      return tx.productionOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toIntakeRow(updated);
  }

  async attachModel3d(
    id: string,
    dto: IntakeModel3dDto,
    _actor: AuthUserPayload,
  ) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== ProductionStatus.APPROVED) {
      throw new BadRequestException(
        'Chỉ cập nhật link 3D cho đơn đã duyệt, chưa có file 3D',
      );
    }

    const model3dUrl = dto.model3dUrl.trim();
    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id },
        data: {
          model3dUrl,
          ...stoneData(dto),
          status: ProductionStatus.READY_FOR_PRODUCTION,
        },
      });
      return tx.productionOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toIntakeRow(updated);
  }

  async submitProductSpecs(
    id: string,
    dto: IntakeProductSpecsDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== ProductionStatus.READY_FOR_PRODUCTION) {
      throw new BadRequestException(
        'Chỉ cập nhật số liệu khi đơn ở bước Chờ SX · Đã có 3D (C)',
      );
    }

    const moldPath = order.hasMold === true;
    // Không khuôn = in sáp resin (thợ 3D, bước 4); có khuôn = bơm sáp (thợ sáp, bước 6).
    const needed = moldPath
      ? Permission.PRODUCTION_WAX
      : Permission.PRODUCTION_MODEL3D;
    if (!userCan(actor, needed)) {
      throw new ForbiddenException(
        moldPath
          ? 'Chỉ thợ sáp được cập nhật số liệu bơm sáp'
          : 'Chỉ thợ 3D được cập nhật số liệu in sáp',
      );
    }
    const nextStatus = moldPath
      ? ProductionStatus.PENDING_WAREHOUSE_CONFIRMATION
      : ProductionStatus.WAX_PRINTED;
    if (
      moldPath &&
      !(dto.castingTreeWeightGram != null && dto.castingTreeWeightGram > 0)
    ) {
      throw new BadRequestException('Nhập trọng lượng cây thông (gram)');
    }
    const existing = new Set(order.images.map((image) => image.publicId));
    const added = this.newImages(dto.images, existing);
    const merged = [
      ...order.images.map((image) => ({
        kind: image.kind,
        url: image.url,
        publicId: image.publicId,
        width: image.width,
        height: image.height,
        sortOrder: image.sortOrder,
      })),
      ...added,
    ].map((image, index) => ({ ...image, sortOrder: index }));

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id },
        data: {
          status: nextStatus,
          productWeightGram: dto.productWeightGram,
          ...(moldPath && dto.castingTreeWeightGram != null
            ? { castingTreeWeightGram: dto.castingTreeWeightGram }
            : {}),
          ...stoneData(dto),
          images: { deleteMany: {}, create: merged },
        },
      });
      return tx.productionOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toIntakeRow(updated);
  }

  /**
   * Bước 4: thợ 3D in sáp nhiều đơn một lần, chụp ảnh cả khay rồi điền cân nặng từng đơn.
   * Chỉ đơn không khuôn ở C; ảnh khay gắn vào mọi đơn trong lượt in.
   */
  async submitWaxPrintBatch(dto: IntakeWaxPrintBatchDto) {
    const ids = dto.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Một đơn chỉ nhập một lần trong lượt in');
    }
    const orders = await this.prisma.productionOrder.findMany({
      where: { id: { in: ids } },
      include: { images: true },
    });
    const byId = new Map(orders.map((order) => [order.id, order]));
    for (const id of ids) {
      const order = byId.get(id);
      if (!order) throw new NotFoundException('Không tìm thấy đơn');
      if (
        order.status !== ProductionStatus.READY_FOR_PRODUCTION ||
        order.hasMold !== false
      ) {
        throw new BadRequestException(
          `Đơn ${order.intakeCode ?? order.code} không ở bước chờ in sáp resin (C, không khuôn)`,
        );
      }
    }
    const tray = this.newImages(dto.images, new Set());
    await this.prisma.runTx(async (tx) => {
      for (const item of dto.items) {
        const order = byId.get(item.id)!;
        const moved = await tx.productionOrder.updateMany({
          where: {
            id: order.id,
            status: ProductionStatus.READY_FOR_PRODUCTION,
          },
          data: {
            status: ProductionStatus.WAX_PRINTED,
            productWeightGram: item.productWeightGram,
          },
        });
        if (moved.count !== 1) {
          throw new ConflictException(
            `Đơn ${order.intakeCode ?? order.code} vừa được cập nhật — tải lại danh sách`,
          );
        }
        const start = order.images.filter(
          (image) => image.kind === ProductionImageKind.PRODUCT,
        ).length;
        await tx.productionOrderImage.createMany({
          data: tray.map((image, index) => ({
            ...image,
            kind: ProductionImageKind.PRODUCT,
            sortOrder: start + index,
            orderId: order.id,
          })),
        });
      }
    });
    return { count: dto.items.length };
  }

  /**
   * Bước 4: thợ 3D in sáp nhiều đơn một lần, chụp ảnh cả khay rồi tách cân nặng từng đơn.
   * Ảnh khay gắn chung cho mọi đơn trong lượt; các đơn sang Đã in sáp (D).
   */
  async waxPrintBatch(dto: WaxPrintBatchDto) {
    const ids = dto.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Một đơn chỉ nhập một lần trong lượt in');
    }
    const orders = await this.prisma.productionOrder.findMany({
      where: { id: { in: ids } },
      include: { images: true },
    });
    const byId = new Map(orders.map((order) => [order.id, order]));
    for (const id of ids) {
      const order = byId.get(id);
      if (!order) throw new NotFoundException('Không tìm thấy đơn');
      if (order.status !== ProductionStatus.READY_FOR_PRODUCTION) {
        throw new BadRequestException(
          `Đơn ${order.intakeCode ?? order.code} không ở bước Chờ SX · Đã có 3D (C)`,
        );
      }
      if (order.hasMold === true) {
        throw new BadRequestException(
          `Đơn ${order.intakeCode ?? order.code} đã có khuôn — đi bước Bơm sáp, không in sáp resin`,
        );
      }
    }

    await this.prisma.runTx(async (tx) => {
      for (const item of dto.items) {
        const order = byId.get(item.id)!;
        const existing = new Set(order.images.map((image) => image.publicId));
        const added = this.newImages(dto.images, existing);
        const base = order.images.length;
        // Chặn hai người cùng nhập một đơn: chỉ đơn còn ở C mới chuyển được.
        const moved = await tx.productionOrder.updateMany({
          where: {
            id: order.id,
            status: ProductionStatus.READY_FOR_PRODUCTION,
          },
          data: {
            status: ProductionStatus.WAX_PRINTED,
            productWeightGram: item.productWeightGram,
          },
        });
        if (moved.count !== 1) {
          throw new BadRequestException(
            `Đơn ${order.intakeCode ?? order.code} vừa được cập nhật — tải lại danh sách`,
          );
        }
        if (added.length) {
          await tx.productionOrderImage.createMany({
            data: added.map((image, index) => ({
              ...image,
              orderId: order.id,
              sortOrder: base + index,
            })),
          });
        }
      }
    });

    const rows = await this.prisma.productionOrder.findMany({
      where: { id: { in: ids } },
      include: {
        images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
      },
    });
    return { items: rows.map(toIntakeRow) };
  }

  /** Bước 5–6: thủ kho xác nhận đã nhận sáp → E (TL phiếu đúc lấy số thợ báo nếu không cân riêng). */
  async confirmWarehouseSpecs(
    id: string,
    dto: ConfirmWarehouseDto,
    actor: AuthUserPayload,
  ) {
    if (!canConfirmIntakeWarehouse(actor)) {
      throw new ForbiddenException(
        'Chỉ thủ kho được xác nhận số liệu sản phẩm',
      );
    }
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== ProductionStatus.PENDING_WAREHOUSE_CONFIRMATION) {
      throw new BadRequestException(
        'Chỉ xác nhận được đơn đang chờ thủ kho xác nhận',
      );
    }

    const confirmedBy = actor.fullName?.trim() || actor.username;
    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id },
        data: {
          status: ProductionStatus.WAX_CONFIRMED,
          waxCheckedByName: confirmedBy,
          ...(dto.checkedWeightGram != null
            ? { waxCheckedWeightGram: dto.checkedWeightGram }
            : {}),
        },
      });
      return tx.productionOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toIntakeRow(updated);
  }

  async submitCastingTreeSpecs(
    id: string,
    dto: IntakeCastingTreeSpecsDto,
    _actor: AuthUserPayload,
  ) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== ProductionStatus.WAX_PRINTED) {
      throw new BadRequestException(
        'Chỉ cập nhật số liệu cây thông khi đơn ở bước Chờ SX · Đã in sáp',
      );
    }

    const existing = new Set(order.images.map((image) => image.publicId));
    const added = this.newImages(dto.images, existing);
    const merged = [
      ...order.images.map((image) => ({
        kind: image.kind,
        url: image.url,
        publicId: image.publicId,
        width: image.width,
        height: image.height,
        sortOrder: image.sortOrder,
      })),
      ...added,
    ].map((image, index) => ({ ...image, sortOrder: index }));

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.productionOrder.update({
        where: { id },
        data: {
          status: ProductionStatus.PENDING_WAREHOUSE_CONFIRMATION,
          castingTreeWeightGram: dto.castingTreeWeightGram,
          images: { deleteMany: {}, create: merged },
        },
      });
      return tx.productionOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toIntakeRow(updated);
  }

  async remove(id: string) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== ProductionStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Chỉ xóa được đơn đang chờ duyệt');
    }
    await this.prisma.productionOrder.delete({ where: { id } });
    await this.cloudinary.destroy(order.images.map((image) => image.publicId));
    return { success: true };
  }

  private fields(dto: UpsertIntakeOrderDto) {
    const createdDate = parseDate(dto.createdDate, 'Ngày tạo');
    const dueDate = dto.dueDate
      ? parseDate(dto.dueDate, 'Thời gian trả hàng')
      : null;
    if (dueDate && dueDate < createdDate) {
      throw new BadRequestException('Ngày trả hàng không được trước ngày tạo');
    }
    return {
      requestType: dto.requestType,
      productName: dto.productName.trim(),
      qty: dto.qty,
      trackingCode: dto.trackingCode?.trim() || null,
      description: dto.description.trim(),
      receivedDate: createdDate,
      dueDate,
    };
  }

  private newImages(images: IntakeOrderImageDto[], existing: Set<string>) {
    const seen = new Set<string>();
    const counters: Record<ProductionImageKind, number> = {
      DETAIL: 0,
      PRODUCT: 0,
      CASTING_TREE: 0,
      CUT_BLANK: 0,
    };
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
}

/** Đá theo 3D: chỉ ghi khi người dùng có nhập, để bước sau không xoá mất số đã khai. */
function stoneData(dto: {
  stoneCount3d?: number | null;
  stoneWeight3dGram?: number | null;
}) {
  return {
    ...(dto.stoneCount3d !== undefined ? { stoneCount: dto.stoneCount3d } : {}),
    ...(dto.stoneWeight3dGram !== undefined
      ? { stoneWeight: dto.stoneWeight3dGram }
      : {}),
  };
}
