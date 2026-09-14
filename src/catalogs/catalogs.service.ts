import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OtherClassKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { slugFromName } from '../util/slug';
import { CreateOtherClassDto, UpdateOtherClassDto } from './dto/other-class.dto';

const catalogSelect = {
  id: true,
  code: true,
  name: true,
  kind: true,
  parentId: true,
  sortOrder: true,
} as const;

@Injectable()
export class CatalogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async list(kind: OtherClassKind = OtherClassKind.CATALOG) {
    if (kind === OtherClassKind.OTHER) {
      await this.inventory.ensureBtpCatalogs();
    }
    const rows = await this.prisma.otherClass.findMany({
      where: { kind },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: catalogSelect,
    });
    const children = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.parentId) continue;
      const list = children.get(row.parentId) ?? [];
      list.push(row);
      children.set(row.parentId, list);
    }
    return rows
      .filter((row) => !row.parentId)
      .map((row) => ({
        ...row,
        children: children.get(row.id) ?? [],
      }));
  }

  async create(dto: CreateOtherClassDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên không được trống');
    let kind = dto.kind ?? OtherClassKind.CATALOG;
    if (dto.parentId) {
      const parent = await this.assertParent(dto.parentId);
      kind = parent.kind;
    }
    await this.assertUniqueName(name, kind, dto.parentId);
    const last = await this.prisma.otherClass.aggregate({
      where: { kind, parentId: dto.parentId ?? null },
      _max: { sortOrder: true },
    });
    const created = await this.prisma.otherClass.create({
      data: {
        code: await this.uniqueCode(name),
        name,
        kind,
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? (last._max.sortOrder ?? 0) + 1,
      },
      select: catalogSelect,
    });
    this.inventory.bustLookups();
    return created;
  }

  async update(id: string, dto: UpdateOtherClassDto) {
    const current = await this.prisma.otherClass.findUnique({
      where: { id },
      select: { id: true, parentId: true, kind: true },
    });
    if (!current) throw new NotFoundException('Không tìm thấy danh mục');
    const name = dto.name?.trim();
    const parentId = dto.parentId === undefined ? current.parentId : dto.parentId;
    if (parentId === id) throw new BadRequestException('Danh mục không thể là cha của chính nó');
    if (parentId) {
      const parent = await this.assertParent(parentId, id);
      if (parent.kind !== current.kind) {
        throw new BadRequestException('Danh mục con phải cùng loại với danh mục cha');
      }
    }
    if (name) await this.assertUniqueName(name, current.kind, parentId, id);
    const updated = await this.prisma.otherClass.update({
      where: { id },
      data: {
        ...(name ? { name, code: await this.uniqueCode(name, id) } : {}),
        ...(dto.parentId !== undefined ? { parentId } : {}),
        ...(dto.sortOrder != null ? { sortOrder: dto.sortOrder } : {}),
      },
      select: catalogSelect,
    });
    this.inventory.bustLookups();
    return updated;
  }

  async remove(id: string) {
    const current = await this.prisma.otherClass.findUnique({
      where: { id },
      select: { id: true, _count: { select: { children: true } } },
    });
    if (!current) throw new NotFoundException('Không tìm thấy danh mục');
    if (current._count.children > 0) {
      throw new BadRequestException('Xóa danh mục con trước khi xóa danh mục này');
    }
    await this.prisma.otherClass.delete({ where: { id } });
    this.inventory.bustLookups();
    return { success: true };
  }

  private async assertParent(parentId: string, exceptId?: string) {
    const parent = await this.prisma.otherClass.findUnique({
      where: { id: parentId },
      select: { id: true, parentId: true, kind: true },
    });
    if (!parent) throw new NotFoundException('Không tìm thấy danh mục cha');
    if (parent.parentId) throw new BadRequestException('Chỉ tạo danh mục con dưới danh mục to');
    if (exceptId && parentId === exceptId) {
      throw new BadRequestException('Danh mục không thể là cha của chính nó');
    }
    return parent;
  }

  private async assertUniqueName(
    name: string,
    kind: OtherClassKind,
    parentId?: string | null,
    exceptId?: string,
  ) {
    const clash = await this.prisma.otherClass.findFirst({
      where: {
        kind,
        name: { equals: name, mode: 'insensitive' },
        parentId: parentId ?? null,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException('Danh mục này đã tồn tại');
  }

  private async uniqueCode(name: string, exceptId?: string) {
    const base = slugFromName(name);
    let code = base;
    let n = 2;
    while (
      await this.prisma.otherClass.findFirst({
        where: { code, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
        select: { id: true },
      })
    ) {
      code = `${base}-${n}`;
      n += 1;
    }
    return code;
  }
}
