import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GenerateLocationsDto, UpdateLocationDto } from './dto/location.dto';
import { decStr } from '../util/money';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(warehouseCode: string) {
    const warehouse = await this.requireWarehouse(warehouseCode);
    const [slots, materials] = await Promise.all([
      this.prisma.warehouseLocation.findMany({
        where: { warehouseId: warehouse.id, isActive: true },
        orderBy: [{ zone: 'asc' }, { aisle: 'asc' }, { level: 'asc' }, { position: 'asc' }],
      }),
      this.prisma.material.findMany({
        where: {
          warehouseId: warehouse.id,
          isActive: true,
          locationCode: { not: null },
        },
        select: {
          id: true,
          sku: true,
          name: true,
          locationCode: true,
          unit: { select: { name: true } },
          shape: { select: { name: true } },
          color: { select: { name: true } },
          balance: { select: { qty: true } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);
    const used = new Map<
      string,
      {
        id: string;
        sku: string | null;
        name: string;
        unit: string;
        qty: string;
        shape: string | null;
        color: string | null;
      }[]
    >();
    for (const row of materials) {
      const code = row.locationCode?.trim();
      if (!code) continue;
      const list = used.get(code) ?? [];
      list.push({
        id: row.id,
        sku: row.sku,
        name: row.name,
        unit: row.unit.name,
        qty: decStr(row.balance?.qty),
        shape: row.shape?.name ?? null,
        color: row.color?.name ?? null,
      });
      used.set(code, list);
    }
    return {
      warehouse,
      items: slots.map((slot) => {
        const occ = used.get(slot.code) ?? [];
        return {
          id: slot.id,
          code: slot.code,
          zone: slot.zone,
          aisle: slot.aisle,
          level: slot.level,
          position: slot.position,
          occupied: occ.length > 0,
          materialId: occ[0]?.id ?? null,
          materialName: occ[0]?.name ?? null,
          materials: occ,
        };
      }),
    };
  }

  async generate(dto: GenerateLocationsDto) {
    const warehouse = await this.requireWarehouse(dto.warehouseCode.trim());
    const zone = dto.zone.trim().toUpperCase();
    const slots = buildSlots(zone, dto.aisleCount, dto.levelCount, dto.positionCount);
    if (slots.length > 2000) {
      throw new BadRequestException('Tối đa 2000 vị trí mỗi lần tạo');
    }

    const existing = await this.prisma.warehouseLocation.findMany({
      where: { warehouseId: warehouse.id, code: { in: slots.map((s) => s.code) } },
      select: { code: true },
    });
    const have = new Set(existing.map((row) => row.code));
    const fresh = slots.filter((slot) => !have.has(slot.code));

    if (fresh.length) {
      await this.prisma.warehouseLocation.createMany({
        data: fresh.map((slot, index) => ({
          warehouseId: warehouse.id,
          zone: slot.zone,
          aisle: slot.aisle,
          level: slot.level,
          position: slot.position,
          code: slot.code,
          sortOrder: index,
        })),
      });
    }

    return {
      created: fresh.length,
      skipped: slots.length - fresh.length,
      total: slots.length,
      from: slots[0]?.code ?? null,
      to: slots[slots.length - 1]?.code ?? null,
    };
  }

  async update(id: string, dto: UpdateLocationDto) {
    const slot = await this.prisma.warehouseLocation.findUnique({
      where: { id },
    });
    if (!slot) throw new NotFoundException('Không tìm thấy vị trí');

    const zone = dto.zone.trim().toUpperCase();
    const level = dto.level.trim().toUpperCase();
    const code = buildLocationCode(zone, dto.aisle, level, dto.position);

    const clash = await this.prisma.warehouseLocation.findFirst({
      where: { warehouseId: slot.warehouseId, code, NOT: { id: slot.id } },
      select: { id: true },
    });
    if (clash) throw new BadRequestException(`Mã vị trí ${code} đã tồn tại`);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (code !== slot.code) {
        await tx.material.updateMany({
          where: { warehouseId: slot.warehouseId, locationCode: slot.code },
          data: { locationCode: code },
        });
      }
      return tx.warehouseLocation.update({
        where: { id: slot.id },
        data: { zone, aisle: dto.aisle, level, position: dto.position, code },
      });
    });

    return {
      id: updated.id,
      code: updated.code,
      zone: updated.zone,
      aisle: updated.aisle,
      level: updated.level,
      position: updated.position,
    };
  }

  async remove(id: string) {
    const slot = await this.prisma.warehouseLocation.findUnique({
      where: { id },
      select: { id: true, code: true, warehouseId: true },
    });
    if (!slot) throw new NotFoundException('Không tìm thấy vị trí');
    const used = await this.prisma.material.findFirst({
      where: { warehouseId: slot.warehouseId, isActive: true, locationCode: slot.code },
      select: { name: true },
    });
    if (used) {
      throw new BadRequestException(`Vị trí ${slot.code} đang dùng cho ${used.name}`);
    }
    await this.prisma.warehouseLocation.delete({ where: { id: slot.id } });
    return { success: true };
  }

  private async requireWarehouse(code: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true, name: true, shortName: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');
    return warehouse;
  }
}

export function buildLocationCode(
  zone: string,
  aisle: number,
  level: string,
  position: number,
) {
  return `${zone}${aisle}${level}${position}`;
}

/** Zone A + 3 dãy + 8 tầng + 10 ô → A1A1 … A3H10 */
function buildSlots(zone: string, aisleCount: number, levelCount: number, positionCount: number) {
  const slots: { zone: string; aisle: number; level: string; position: number; code: string }[] =
    [];
  for (let aisle = 1; aisle <= aisleCount; aisle += 1) {
    for (let i = 0; i < levelCount; i += 1) {
      const level = String.fromCharCode(65 + i);
      for (let position = 1; position <= positionCount; position += 1) {
        slots.push({
          zone,
          aisle,
          level,
          position,
          code: buildLocationCode(zone, aisle, level, position),
        });
      }
    }
  }
  return slots;
}

