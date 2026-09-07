import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { decStr } from '../util/money';
import { UpsertBtpWaitingDto } from './dto/waiting-item.dto';

export const BTP_WAREHOUSE_CODE = 'btp-cho-vao-da';

@Injectable()
export class BtpService {
  constructor(private readonly prisma: PrismaService) {}

  async list(code: string) {
    const warehouse = await this.requireWarehouse(code);
    const rows = await this.prisma.btpWaitingItem.findMany({
      where: { warehouseId: warehouse.id },
      orderBy: [{ sortOrder: 'asc' }, { receivedAt: 'asc' }],
      include: { unit: { select: { id: true, name: true } } },
    });
    const zero = new Prisma.Decimal(0);
    const totals = rows.reduce(
      (acc, row) => ({
        qty: acc.qty.add(row.qty),
        weight: acc.weight.add(row.weight),
      }),
      { qty: zero, weight: zero },
    );
    return {
      warehouse,
      totals: { qty: decStr(totals.qty), weight: decStr(totals.weight) },
      items: rows.map((row) => this.toRow(row)),
    };
  }

  async create(code: string, dto: UpsertBtpWaitingDto, actor: AuthUserPayload) {
    const warehouse = await this.requireWarehouse(code);
    const craftsman = await this.resolveCraftsman(dto.craftsmanUserId);
    const unit = await this.resolveUnit(dto.unitId, dto.unitName);
    const last = await this.prisma.btpWaitingItem.aggregate({
      where: { warehouseId: warehouse.id },
      _max: { sortOrder: true },
    });

    const row = await this.prisma.btpWaitingItem.create({
      data: {
        warehouseId: warehouse.id,
        sortOrder: (last._max.sortOrder ?? 0) + 1,
        receivedAt: dateOnly(dto.receivedAt),
        craftsmanUserId: craftsman.id,
        craftsmanName: craftsman.name,
        name: requireName(dto.name),
        unitId: unit.id,
        unitName: unit.name,
        qty: new Prisma.Decimal(dto.qty),
        weight: new Prisma.Decimal(dto.weight),
        note: dto.note?.trim() || null,
        enteredBy: actorDisplayName(actor),
      },
      include: { unit: { select: { id: true, name: true } } },
    });
    return this.toRow(row);
  }

  async update(code: string, id: string, dto: UpsertBtpWaitingDto) {
    const warehouse = await this.requireWarehouse(code);
    const existing = await this.prisma.btpWaitingItem.findFirst({
      where: { id, warehouseId: warehouse.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Không tìm thấy dòng BTP');

    const craftsman = await this.resolveCraftsman(dto.craftsmanUserId);
    const unit = await this.resolveUnit(dto.unitId, dto.unitName);

    const row = await this.prisma.btpWaitingItem.update({
      where: { id: existing.id },
      data: {
        receivedAt: dateOnly(dto.receivedAt),
        craftsmanUserId: craftsman.id,
        craftsmanName: craftsman.name,
        name: requireName(dto.name),
        unitId: unit.id,
        unitName: unit.name,
        qty: new Prisma.Decimal(dto.qty),
        weight: new Prisma.Decimal(dto.weight),
        note: dto.note?.trim() || null,
      },
      include: { unit: { select: { id: true, name: true } } },
    });
    return this.toRow(row);
  }

  async remove(code: string, id: string) {
    const warehouse = await this.requireWarehouse(code);
    const existing = await this.prisma.btpWaitingItem.findFirst({
      where: { id, warehouseId: warehouse.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Không tìm thấy dòng BTP');
    await this.prisma.btpWaitingItem.delete({ where: { id: existing.id } });
    return { success: true };
  }

  private async requireWarehouse(code: string) {
    if (code !== BTP_WAREHOUSE_CODE) {
      throw new BadRequestException('Kho này không dùng sổ BTP chờ vào đá');
    }
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true, name: true, shortName: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');
    return warehouse;
  }

  private async resolveCraftsman(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, fullName: true, username: true },
    });
    if (!user) throw new BadRequestException('Chọn thợ nguội từ tài khoản hệ thống');
    return { id: user.id, name: actorDisplayName(user) };
  }

  private async resolveUnit(unitId?: string | null, unitName?: string) {
    if (unitId) {
      const unit = await this.prisma.unit.findUnique({
        where: { id: unitId },
        select: { id: true, name: true },
      });
      if (!unit) throw new NotFoundException('Không tìm thấy đơn vị');
      return unit;
    }
    const byName = unitName?.trim();
    if (byName) {
      const unit = await this.prisma.unit.findFirst({
        where: { name: byName },
        select: { id: true, name: true },
      });
      if (unit) return unit;
    }
    const fallback = await this.prisma.unit.findUnique({
      where: { code: 'chiec' },
      select: { id: true, name: true },
    });
    if (!fallback) throw new BadRequestException('Chọn đơn vị tính');
    return fallback;
  }

  private toRow(row: {
    id: string;
    sortOrder: number;
    receivedAt: Date;
    craftsmanUserId: string | null;
    craftsmanName: string;
    name: string;
    unitName: string;
    unitId: string | null;
    qty: Prisma.Decimal;
    weight: Prisma.Decimal;
    note: string | null;
    enteredBy: string | null;
    unit?: { id: string; name: string } | null;
  }) {
    return {
      id: row.id,
      stt: row.sortOrder,
      receivedAt: row.receivedAt.toISOString().slice(0, 10),
      craftsmanUserId: row.craftsmanUserId,
      craftsmanName: row.craftsmanName,
      name: row.name,
      unit: row.unit?.name ?? row.unitName,
      unitId: row.unitId,
      qty: decStr(row.qty),
      weight: decStr(row.weight),
      note: row.note,
      enteredBy: row.enteredBy,
    };
  }
}

function requireName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new BadRequestException('Tên bán thành phẩm không được trống');
  return trimmed;
}

function dateOnly(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function actorDisplayName(actor: { fullName: string; username: string }) {
  return actor.fullName.trim() || actor.username;
}
