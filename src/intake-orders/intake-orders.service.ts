import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IntakeOrderStatus, Prisma, ProductionImageKind } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { recordEditLog } from '../edit-logs/edit-log';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../uploads/cloudinary.service';
import {
  ApproveIntakeOrderDto,
  RejectIntakeOrderDto,
  IntakeModel3dDto,
  IntakeCastingTreeSpecsDto,
  IntakeProductSpecsDto,
  IntakeOrderImageDto,
  ListIntakeOrdersQuery,
  UpsertIntakeOrderDto,
} from './dto/intake-order.dto';
import { canConfirmIntakeWarehouse } from './intake-warehouse-access';

const CREATE_RETRIES = 5;
const SX_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function intakeCode(seq: number) {
  return `DH${String(seq).padStart(3, '0')}`;
}

function randomSxCode() {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += SX_CODE_CHARS[Math.floor(Math.random() * SX_CODE_CHARS.length)];
  }
  return `S${suffix}`;
}

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

@Injectable()
export class IntakeOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async list(query: ListIntakeOrdersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const keyword = query.search?.trim();
    const where: Prisma.IntakeOrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.requestType ? { requestType: query.requestType } : {}),
      ...(keyword
        ? {
            OR: [
              { code: { contains: keyword, mode: 'insensitive' } },
              { sxCode: { contains: keyword, mode: 'insensitive' } },
              { trackingCode: { contains: keyword, mode: 'insensitive' } },
              { placedBy: { contains: keyword, mode: 'insensitive' } },
              { description: { contains: keyword, mode: 'insensitive' } },
              { productName: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.intakeOrder.count({ where }),
      this.prisma.intakeOrder.findMany({
        where,
        orderBy: [{ createdDate: 'desc' }, { seq: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      }),
    ]);
    return { items: rows.map(toRow), total, page, pageSize };
  }

  async create(dto: UpsertIntakeOrderDto, actor: AuthUserPayload) {
    const data = {
      ...this.fields(dto),
      placedBy: actor.fullName?.trim() || actor.username,
    };
    const images = this.newImages(dto.images, new Set());

    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.prisma.runTx(async (tx) => {
          const last = await tx.intakeOrder.findFirst({
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          const seq = (last?.seq ?? 0) + 1;
          return tx.intakeOrder.create({
            data: {
              ...data,
              seq,
              code: intakeCode(seq),
              sxCode: randomSxCode(),
              status: IntakeOrderStatus.PENDING_APPROVAL,
              images: { create: images },
            },
            include: {
              images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
            },
          });
        });
        return toRow(created);
      } catch (error) {
        if (isUniqueViolation(error) && attempt < CREATE_RETRIES) continue;
        throw error;
      }
    }
  }

  async update(id: string, dto: UpsertIntakeOrderDto, actor: AuthUserPayload) {
    const order = await this.prisma.intakeOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (
      dto.status === IntakeOrderStatus.APPROVED &&
      order.status !== IntakeOrderStatus.APPROVED
    ) {
      throw new BadRequestException(
        'Dùng nút Duyệt trên Lệnh sản xuất để chuyển sang Đã duyệt',
      );
    }

    const { placedBy: _ignored, createdDate: _created, ...data } = this.fields(dto);
    const existing = new Set(order.images.map((image) => image.publicId));
    const images = this.newImages(dto.images, existing);
    const kept = new Set(images.map((image) => image.publicId));
    const removed = order.images
      .map((image) => image.publicId)
      .filter((publicId) => !kept.has(publicId));

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.intakeOrder.update({
        where: { id },
        data: {
          ...data,
          createdDate: order.createdDate,
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          images: { deleteMany: {}, create: images },
        },
      });
      await recordEditLog(tx, {
        entityType: 'intake_order_form',
        entityId: id,
        reason: dto.editReason,
        changedBy: actor.fullName?.trim() || actor.username,
      });
      return tx.intakeOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    await this.cloudinary.destroy(removed);
    return toRow(updated);
  }

  async approve(id: string, dto: ApproveIntakeOrderDto, actor: AuthUserPayload) {
    const order = await this.prisma.intakeOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Chỉ duyệt được đơn đang chờ duyệt');
    }

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.intakeOrder.update({
        where: { id },
        data: {
          hasMold: dto.hasMold,
          status: dto.hasMold
            ? IntakeOrderStatus.READY_FOR_PRODUCTION
            : IntakeOrderStatus.APPROVED,
        },
      });
      return tx.intakeOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toRow(updated);
  }

  async reject(id: string, dto: RejectIntakeOrderDto, actor: AuthUserPayload) {
    const order = await this.prisma.intakeOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Chỉ từ chối được đơn đang chờ duyệt');
    }

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.intakeOrder.update({
        where: { id },
        data: { status: IntakeOrderStatus.REJECTED, hasMold: null },
      });
      return tx.intakeOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toRow(updated);
  }

  async attachModel3d(id: string, dto: IntakeModel3dDto, actor: AuthUserPayload) {
    const order = await this.prisma.intakeOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.APPROVED) {
      throw new BadRequestException(
        'Chỉ cập nhật link 3D cho đơn đã duyệt, chưa có file 3D',
      );
    }

    const model3dUrl = dto.model3dUrl.trim();
    const updated = await this.prisma.runTx(async (tx) => {
      await tx.intakeOrder.update({
        where: { id },
        data: {
          model3dUrl,
          status: IntakeOrderStatus.READY_FOR_PRODUCTION,
        },
      });
      return tx.intakeOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toRow(updated);
  }

  async submitProductSpecs(
    id: string,
    dto: IntakeProductSpecsDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.prisma.intakeOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.READY_FOR_PRODUCTION) {
      throw new BadRequestException(
        'Chỉ cập nhật số liệu khi đơn ở bước Chờ SX · Đã có 3D',
      );
    }

    const moldPath = order.hasMold === true;
    const nextStatus = moldPath
      ? IntakeOrderStatus.PENDING_WAREHOUSE_CONFIRMATION
      : IntakeOrderStatus.WAX_PRINTED;
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
      await tx.intakeOrder.update({
        where: { id },
        data: {
          status: nextStatus,
          productWeightGram: dto.productWeightGram,
          images: { deleteMany: {}, create: merged },
        },
      });
      return tx.intakeOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toRow(updated);
  }

  async confirmWarehouseSpecs(id: string, actor: AuthUserPayload) {
    if (!canConfirmIntakeWarehouse(actor)) {
      throw new ForbiddenException('Chỉ thủ kho được xác nhận số liệu sản phẩm');
    }
    const order = await this.prisma.intakeOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.PENDING_WAREHOUSE_CONFIRMATION) {
      throw new BadRequestException(
        'Chỉ xác nhận được đơn đang chờ thủ kho xác nhận',
      );
    }

    const updated = await this.prisma.runTx(async (tx) => {
      await tx.intakeOrder.update({
        where: { id },
        data: { status: IntakeOrderStatus.WAX_CONFIRMED },
      });
      return tx.intakeOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toRow(updated);
  }

  async submitCastingTreeSpecs(
    id: string,
    dto: IntakeCastingTreeSpecsDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.prisma.intakeOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.WAX_PRINTED) {
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
      await tx.intakeOrder.update({
        where: { id },
        data: {
          status: IntakeOrderStatus.PENDING_WAREHOUSE_CONFIRMATION,
          castingTreeWeightGram: dto.castingTreeWeightGram,
          images: { deleteMany: {}, create: merged },
        },
      });
      return tx.intakeOrder.findUniqueOrThrow({
        where: { id },
        include: {
          images: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    return toRow(updated);
  }

  async remove(id: string) {
    const order = await this.prisma.intakeOrder.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Chỉ xóa được đơn đang chờ duyệt');
    }
    await this.prisma.intakeOrder.delete({ where: { id } });
    await this.cloudinary.destroy(order.images.map((image) => image.publicId));
    return { success: true };
  }

  private fields(dto: UpsertIntakeOrderDto) {
    const createdDate = parseDate(dto.createdDate, 'Ngày tạo');
    const dueDate = dto.dueDate ? parseDate(dto.dueDate, 'Thời gian trả hàng') : null;
    if (dueDate && dueDate < createdDate) {
      throw new BadRequestException('Ngày trả hàng không được trước ngày tạo');
    }
    return {
      requestType: dto.requestType,
      productName: dto.productName.trim(),
      qty: dto.qty,
      trackingCode: dto.trackingCode?.trim() || null,
      placedBy: dto.placedBy.trim(),
      description: dto.description.trim(),
      createdDate,
      dueDate,
    };
  }

  private newImages(images: IntakeOrderImageDto[], existing: Set<string>) {
    const seen = new Set<string>();
    const counters: Record<ProductionImageKind, number> = {
      DETAIL: 0,
      PRODUCT: 0,
      CASTING_TREE: 0,
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

type IntakeRow = Prisma.IntakeOrderGetPayload<{
  include: { images: true };
}>;

function toRow(row: IntakeRow) {
  return {
    id: row.id,
    code: row.code,
    sxCode: row.sxCode,
    status: row.status,
    requestType: row.requestType,
    productName: row.productName,
    qty: row.qty,
    trackingCode: row.trackingCode,
    placedBy: row.placedBy,
    description: row.description,
    createdDate: row.createdDate.toISOString().slice(0, 10),
    dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
    hasMold: row.hasMold,
    model3dUrl: row.model3dUrl,
    productWeightGram:
      row.productWeightGram != null ? row.productWeightGram.toString() : null,
    castingTreeWeightGram:
      row.castingTreeWeightGram != null
        ? row.castingTreeWeightGram.toString()
        : null,
    createdAt: row.createdAt.toISOString(),
    images: row.images.map((image) => ({
      kind: image.kind,
      url: image.url,
      publicId: image.publicId,
      width: image.width,
      height: image.height,
    })),
  };
}
