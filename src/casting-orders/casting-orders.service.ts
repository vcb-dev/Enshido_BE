import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserPayload } from '../auth/types';
import { recordEditLog } from '../edit-logs/edit-log';
import { METAL_KIND_LABEL, decStr } from '../util/money';
import {
  CreateCastingOrderDto,
  ListCastingOrdersQuery,
} from './dto/casting-order.dto';

const NVL_WAREHOUSE = 'nvl-chinh';

@Injectable()
export class CastingOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCastingOrdersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const sku = query.sku?.trim();
    const name = query.name?.trim();
    const keyword = query.search?.trim();
    const where: Prisma.CastingOrderWhereInput = {
      ...(sku
        ? { lines: { some: { materialSku: { contains: sku, mode: 'insensitive' } } } }
        : {}),
      ...(name
        ? { lines: { some: { materialName: { contains: name, mode: 'insensitive' } } } }
        : {}),
      ...(keyword
        ? {
            OR: [
              { code: { contains: keyword, mode: 'insensitive' } },
              { lines: { some: { materialSku: { contains: keyword, mode: 'insensitive' } } } },
              { lines: { some: { materialName: { contains: keyword, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.castingOrder.count({ where }),
      this.prisma.castingOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      }),
    ]);
    return {
      items: rows.map(toRow),
      total,
      page,
      pageSize,
    };
  }

  /** Mã NVL còn hoạt động trên Tồn kho NVL chính — để chọn lúc nhập lệnh đúc. */
  async nvlOptions() {
    const rows = await this.prisma.material.findMany({
      where: { isActive: true, warehouse: { code: NVL_WAREHOUSE } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        sku: true,
        name: true,
        locationCode: true,
        metalKind: true,
        sizeLabel: true,
        unit: { select: { name: true } },
        materialType: { select: { name: true } },
        shape: { select: { name: true } },
        color: { select: { name: true } },
        otherClass: { select: { name: true } },
      },
    });
    return rows
      .filter((row) => row.sku)
      .map((row) => ({
        id: row.id,
        sku: row.sku as string,
        name: row.name,
        locationCode: row.locationCode,
        category: row.metalKind
          ? (METAL_KIND_LABEL[row.metalKind] ?? row.metalKind)
          : (row.otherClass?.name ?? null),
        materialType: row.materialType?.name ?? null,
        shape: row.shape?.name ?? null,
        color: row.color?.name ?? null,
        unit: row.unit.name,
        sizeLabel: row.sizeLabel,
      }));
  }

  async create(dto: CreateCastingOrderDto) {
    const code = dto.code.trim();
    if (!code) throw new BadRequestException('Nhập mã đúc');
    const lines = await this.lineSnapshots(dto.lines);

    try {
      const created = await this.prisma.castingOrder.create({
        data: {
          code,
          moldCount: dto.moldCount,
          lines: {
            create: lines.map((line, index) => ({ sortOrder: index, ...line })),
          },
        },
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      });
      return toRow(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Mã đúc đã tồn tại');
      }
      throw error;
    }
  }

  async update(id: string, dto: CreateCastingOrderDto, actor: AuthUserPayload) {
    const current = await this.prisma.castingOrder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!current) throw new NotFoundException('Không tìm thấy lệnh đúc');

    const code = dto.code.trim();
    if (!code) throw new BadRequestException('Nhập mã đúc');
    const lines = await this.lineSnapshots(dto.lines);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.castingOrderLine.deleteMany({ where: { castingOrderId: id } });
        const row = await tx.castingOrder.update({
          where: { id },
          data: {
            code,
            moldCount: dto.moldCount,
            lines: {
              create: lines.map((line, index) => ({ sortOrder: index, ...line })),
            },
          },
          include: { lines: { orderBy: { sortOrder: 'asc' } } },
        });
        await recordEditLog(tx, {
          entityType: 'casting_order',
          entityId: id,
          reason: dto.editReason,
          changedBy: actor.fullName?.trim() || actor.username,
        });
        return row;
      });
      return toRow(updated);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Mã đúc đã tồn tại');
      }
      throw error;
    }
  }

  private async lineSnapshots(lines: CreateCastingOrderDto['lines']) {
    const materialIds = lines.map((line) => line.materialId);
    const unique = new Set(materialIds);
    if (unique.size !== materialIds.length) {
      throw new BadRequestException('Mỗi mã NVL chỉ chọn một lần');
    }
    return Promise.all(
      lines.map(async (line) => {
        const gram = new Prisma.Decimal(line.gramQty);
        if (gram.lte(0)) {
          throw new BadRequestException('Số gram phải lớn hơn 0');
        }
        return { ...(await this.materialSnapshot(line.materialId)), gramQty: gram };
      }),
    );
  }

  private async materialSnapshot(materialId: string) {
    const material = await this.prisma.material.findFirst({
      where: {
        id: materialId,
        isActive: true,
        warehouse: { code: NVL_WAREHOUSE },
      },
      select: {
        id: true,
        sku: true,
        name: true,
        locationCode: true,
        metalKind: true,
        unit: { select: { name: true } },
        materialType: { select: { name: true } },
        shape: { select: { name: true } },
        color: { select: { name: true } },
        otherClass: { select: { name: true } },
      },
    });
    if (!material) throw new NotFoundException('Không tìm thấy mã NVL trên Tồn');
    return {
      materialId: material.id,
      materialSku: material.sku,
      materialName: material.name,
      locationCode: material.locationCode,
      category: material.metalKind
        ? (METAL_KIND_LABEL[material.metalKind] ?? material.metalKind)
        : (material.otherClass?.name ?? null),
      materialType: material.materialType?.name ?? null,
      shape: material.shape?.name ?? null,
      color: material.color?.name ?? null,
      unit: material.unit.name,
    };
  }
}

function toRow(row: {
  id: string;
  code: string;
  moldCount: number;
  createdAt: Date;
  lines: Array<{
    id: string;
    materialId: string;
    materialSku: string | null;
    materialName: string;
    locationCode: string | null;
    category: string | null;
    materialType: string | null;
    shape: string | null;
    color: string | null;
    unit: string;
    gramQty: Prisma.Decimal;
  }>;
}) {
  return {
    id: row.id,
    code: row.code,
    moldCount: row.moldCount,
    lines: row.lines.map((line) => ({
      id: line.id,
      materialId: line.materialId,
      materialSku: line.materialSku,
      materialName: line.materialName,
      locationCode: line.locationCode,
      category: line.category,
      materialType: line.materialType,
      shape: line.shape,
      color: line.color,
      unit: line.unit,
      gramQty: decStr(line.gramQty),
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
