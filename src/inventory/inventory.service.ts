import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MaterialClass, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCache } from '../util/ttl-cache';
import { availabilityOf, CLASS_LABEL, decStr } from '../util/money';
import { CreateInboundDto } from './dto/inbound.dto';
import { CreateOutboundDto } from './dto/outbound.dto';
import { CreateStockDto, UpdateStockDto } from './dto/update-stock.dto';

const LOOKUPS_TTL_MS = 10 * 60_000;
const WAREHOUSES_TTL_MS = 2 * 60_000;
const STOCK_TTL_MS = 12_000;

const warehouseSelect = {
  id: true,
  code: true,
  name: true,
  shortName: true,
  description: true,
  parentId: true,
  sortOrder: true,
} as const;

const lookupSelect = { id: true, code: true, name: true } as const;

const materialStockSelect = {
  id: true,
  sku: true,
  name: true,
  locationCode: true,
  unitId: true,
  materialTypeId: true,
  shapeId: true,
  colorId: true,
  classification: true,
  note: true,
  sortOrder: true,
  reorderPoint: true,
  createdAt: true,
  unit: { select: { id: true, name: true } },
  materialType: { select: { id: true, name: true } },
  shape: { select: { id: true, name: true } },
  color: { select: { id: true, name: true } },
  balance: true,
} as const;

type MaterialStock = Prisma.MaterialGetPayload<{
  select: typeof materialStockSelect;
}>;

type PriceLayer = {
  kind: 'opening' | 'inbound';
  unitPrice: Prisma.Decimal;
  remaining: Prisma.Decimal;
};

type PriceTake = {
  kind: 'opening' | 'inbound';
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
};

@Injectable()
export class InventoryService {
  private readonly cache = new TtlCache();

  constructor(private readonly prisma: PrismaService) {}

  async listWarehouses() {
    const cached = this.cache.get<Awaited<ReturnType<InventoryService['loadWarehouses']>>>(
      'warehouses',
    );
    if (cached) return cached;
    const rows = await this.loadWarehouses();
    this.cache.set('warehouses', rows, WAREHOUSES_TTL_MS);
    return rows;
  }

  private loadWarehouses() {
    return this.prisma.warehouse.findMany({
      where: { isActive: true, parentId: null },
      select: {
        ...warehouseSelect,
        children: {
          where: { isActive: true },
          select: warehouseSelect,
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async getWarehouse(code: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: {
        ...warehouseSelect,
        children: {
          where: { isActive: true },
          select: warehouseSelect,
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');
    return warehouse;
  }

  async listLookups() {
    const cached = this.cache.get<{
      units: { id: string; code: string; name: string }[];
      materialTypes: { id: string; code: string; name: string }[];
      shapes: { id: string; code: string; name: string }[];
      colors: { id: string; code: string; name: string }[];
      suppliers: { id: string; code: string; name: string }[];
    }>('lookups');
    if (cached) return cached;
    const [units, materialTypes, shapes, colors, suppliers] = await Promise.all([
      this.prisma.unit.findMany({
        select: lookupSelect,
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.materialType.findMany({
        select: lookupSelect,
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.shape.findMany({
        select: lookupSelect,
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.color.findMany({
        select: lookupSelect,
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.supplier.findMany({
        select: lookupSelect,
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    const payload = { units, materialTypes, shapes, colors, suppliers };
    this.cache.set('lookups', payload, LOOKUPS_TTL_MS);
    return payload;
  }

  async listStock(code: string) {
    const cacheKey = `stock:${code}`;
    const cached = this.cache.get<Awaited<ReturnType<InventoryService['loadStock']>>>(
      cacheKey,
    );
    if (cached) return cached;
    const payload = await this.loadStock(code);
    this.cache.set(cacheKey, payload, STOCK_TTL_MS);
    return payload;
  }

  private async loadStock(code: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: warehouseSelect,
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const [materials, inboundMap, outboundMap, firstInboundMap, layerMap] = await Promise.all([
      this.prisma.material.findMany({
        where: { warehouseId: warehouse.id, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: materialStockSelect,
      }),
      this.inboundSums(warehouse.id),
      this.outboundSums(warehouse.id),
      this.firstInboundDates(warehouse.id),
      this.remainingLayersByMaterial(warehouse.id),
    ]);

    const zero = new Prisma.Decimal(0);
    const items = materials.map((m) =>
      this.toStockRow(
        m,
        inboundMap.get(m.id),
        outboundMap.get(m.id),
        firstInboundMap.get(m.id),
        layerMap.get(m.id),
      ),
    );
    const totals = materials.reduce(
      (acc, m) => {
        const b = m.balance;
        const nxt = nxtFigures(
          b?.openingQty ?? zero,
          b?.openingAmount ?? zero,
          inboundMap.get(m.id),
          outboundMap.get(m.id),
        );
        return {
          openingQty: acc.openingQty.add(b?.openingQty ?? 0),
          openingAmount: acc.openingAmount.add(b?.openingAmount ?? 0),
          inQty: acc.inQty.add(nxt.inQty),
          inAmount: acc.inAmount.add(nxt.inAmount),
          outQty: acc.outQty.add(nxt.outQty),
          outAmount: acc.outAmount.add(nxt.outAmount),
          qty: acc.qty.add(nxt.qty),
          amount: acc.amount.add(nxt.amount),
        };
      },
      {
        openingQty: zero,
        openingAmount: zero,
        inQty: zero,
        inAmount: zero,
        outQty: zero,
        outAmount: zero,
        qty: zero,
        amount: zero,
      },
    );

    return {
      warehouse,
      totals: {
        openingQty: decStr(totals.openingQty),
        openingAmount: decStr(totals.openingAmount),
        inQty: decStr(totals.inQty),
        inAmount: decStr(totals.inAmount),
        outQty: decStr(totals.outQty),
        outAmount: decStr(totals.outAmount),
        qty: decStr(totals.qty),
        amount: decStr(totals.amount),
      },
      items,
    };
  }

  async createStock(code: string, dto: CreateStockDto) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên NVL không được trống');

    const unit = await this.prisma.unit.findUnique({
      where: { id: dto.unitId },
      select: { id: true, name: true },
    });
    if (!unit) throw new NotFoundException('Không tìm thấy đơn vị');

    const sku = dto.sku?.trim() || null;
    const [clash, , last] = await Promise.all([
      sku
        ? this.prisma.material.findFirst({
            where: { warehouseId: warehouse.id, sku, isActive: true },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.assertLookups(dto.shapeId, dto.colorId, dto.materialTypeId),
      this.prisma.material.aggregate({
        where: { warehouseId: warehouse.id, isActive: true },
        _max: { sortOrder: true },
      }),
    ]);
    if (clash) throw new ConflictException('Mã NVL đã tồn tại trong kho này');

    const nameClash = await this.prisma.material.findFirst({
      where: {
        warehouseId: warehouse.id,
        name: { equals: name, mode: 'insensitive' },
        isActive: true,
      },
      select: { id: true },
    });
    if (nameClash) throw new ConflictException('Tên NVL đã tồn tại trong kho này');

    const sortOrder = (last._max.sortOrder ?? 0) + 1;
    const dec = (value?: string) =>
      value == null || value === '' ? new Prisma.Decimal(0) : new Prisma.Decimal(value);

    const openingQty = dec(dto.openingQty);
    const stockUnitPrice = dec(dto.stockUnitPrice);
    const openingAmount = openingMoney(openingQty, stockUnitPrice);

    const created = await this.prisma.$transaction(async (tx) => {
      const material = await tx.material.create({
        data: {
          warehouseId: warehouse.id,
          sku,
          name,
          locationCode: dto.locationCode?.trim() || null,
          unitId: dto.unitId,
          shapeId: dto.shapeId || null,
          colorId: dto.colorId || null,
          materialTypeId: dto.materialTypeId || null,
          classification: classificationOf(warehouse.code),
          note: dto.note?.trim() || null,
          sortOrder,
        },
      });
      await tx.stockBalance.create({
        data: {
          warehouseId: warehouse.id,
          materialId: material.id,
          openingQty,
          openingAmount,
          stockUnitPrice,
          qty: openingQty,
          amount: openingAmount,
        },
      });
      return tx.material.findUniqueOrThrow({
        where: { id: material.id },
        select: materialStockSelect,
      });
    });

    this.bustWarehouseCaches(code);
    return this.toStockRow(created);
  }

  async updateStock(code: string, materialId: string, dto: UpdateStockDto) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const material = await this.prisma.material.findFirst({
      where: { id: materialId, warehouseId: warehouse.id, isActive: true },
      select: { id: true, name: true, sku: true, unitId: true },
    });
    if (!material) throw new NotFoundException('Không tìm thấy NVL');

    const sku =
      dto.sku === undefined ? undefined : dto.sku.trim() || null;
    if (sku) {
      const clash = await this.prisma.material.findFirst({
        where: {
          warehouseId: warehouse.id,
          sku,
          isActive: true,
          NOT: { id: material.id },
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException('Mã NVL đã tồn tại trong kho này');
    }

    let unitRow: { id: string; name: string } | null = null;
    if (dto.unitId) {
      unitRow = await this.prisma.unit.findUnique({
        where: { id: dto.unitId },
        select: { id: true, name: true },
      });
      if (!unitRow) throw new NotFoundException('Không tìm thấy đơn vị');
    }
    await this.assertLookups(dto.shapeId, dto.colorId, dto.materialTypeId);

    if (dto.name?.trim()) {
      const nameClash = await this.prisma.material.findFirst({
        where: {
          warehouseId: warehouse.id,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
          isActive: true,
          NOT: { id: material.id },
        },
        select: { id: true },
      });
      if (nameClash) throw new ConflictException('Tên NVL đã tồn tại trong kho này');
    }

    const dec = (value?: string) =>
      value == null ? undefined : new Prisma.Decimal(value);

    await this.prisma.$transaction(async (tx) => {
      await tx.material.update({
        where: { id: material.id },
        data: {
          ...(dto.sortOrder != null ? { sortOrder: dto.sortOrder } : {}),
          ...(sku !== undefined ? { sku } : {}),
          ...(dto.locationCode != null
            ? { locationCode: dto.locationCode.trim() || null }
            : {}),
          ...(dto.name != null ? { name: dto.name.trim() } : {}),
          ...(dto.unitId ? { unitId: dto.unitId } : {}),
          ...(dto.shapeId !== undefined ? { shapeId: dto.shapeId } : {}),
          ...(dto.colorId !== undefined ? { colorId: dto.colorId } : {}),
          ...(dto.materialTypeId !== undefined
            ? { materialTypeId: dto.materialTypeId }
            : {}),
          ...(dto.classification ? { classification: dto.classification } : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
        },
      });

      if (dto.name != null || sku !== undefined || dto.unitId) {
        await this.syncMaterialLines(tx, material.id, {
          name: dto.name?.trim() || material.name,
          sku: sku !== undefined ? sku : material.sku,
          unitId: dto.unitId || material.unitId,
          unitName: unitRow?.name,
        });
      }

      const current = await tx.stockBalance.findUnique({
        where: { materialId: material.id },
        select: { openingQty: true, stockUnitPrice: true },
      });
      const zero = new Prisma.Decimal(0);
      const openingQty = dec(dto.openingQty) ?? current?.openingQty ?? zero;
      const stockUnitPrice = dec(dto.stockUnitPrice) ?? current?.stockUnitPrice ?? zero;
      const openingAmount = openingMoney(openingQty, stockUnitPrice);

      await tx.stockBalance.upsert({
        where: { materialId: material.id },
        create: {
          warehouseId: warehouse.id,
          materialId: material.id,
          openingQty: openingQty,
          openingAmount,
          stockUnitPrice,
          qty: openingQty,
          amount: openingAmount,
        },
        update: {
          openingQty,
          openingAmount,
          stockUnitPrice,
        },
      });
      await this.recomputeStockBalance(tx, warehouse.id, material.id);
    });

    const [updated, inboundMap, outboundMap, firstInboundMap] = await Promise.all([
      this.prisma.material.findUniqueOrThrow({
        where: { id: material.id },
        select: materialStockSelect,
      }),
      this.inboundSums(warehouse.id, [material.id]),
      this.outboundSums(warehouse.id, [material.id]),
      this.firstInboundDates(warehouse.id, [material.id]),
    ]);
    this.bustWarehouseCaches(code);
    return this.toStockRow(
      updated,
      inboundMap.get(material.id),
      outboundMap.get(material.id),
      firstInboundMap.get(material.id),
    );
  }

  async listInbounds(code: string) {
    const cacheKey = `inbounds:${code}`;
    const cached = this.cache.get<{
      warehouse: { id: string; code: string; name: string; shortName: string };
      totals: { qty: string; amount: string };
      items: ReturnType<InventoryService['toInboundRow']>[];
    }>(cacheKey);
    if (cached) return cached;
    const payload = await this.loadInbounds(code);
    this.cache.set(cacheKey, payload, STOCK_TTL_MS);
    return payload;
  }

  private async loadInbounds(code: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true, name: true, shortName: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const rows = await this.prisma.stockInbound.findMany({
      where: { warehouseId: warehouse.id },
      orderBy: [{ sortOrder: 'asc' }, { receivedAt: 'asc' }],
      include: {
        unit: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        material: { select: { id: true, sku: true } },
      },
    });

    const zero = new Prisma.Decimal(0);
    const totals = rows.reduce(
      (acc, row) => ({
        qty: acc.qty.add(row.qty),
        amount: acc.amount.add(row.amount),
      }),
      { qty: zero, amount: zero },
    );

    return {
      warehouse,
      totals: { qty: decStr(totals.qty), amount: decStr(totals.amount) },
      items: rows.map((row) => this.toInboundRow(row)),
    };
  }

  async createInbound(code: string, dto: CreateInboundDto) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên hàng không được trống');

    const qty = new Prisma.Decimal(dto.qty);
    const prices = exclusivePrices(dto.stockUnitPrice, dto.unitPrice);
    const amount = qty.mul(prices.unit).toDecimalPlaces(2);
    const applyToStock = dto.applyToStock !== false;

    const [unit, supplier, last, existing] = await Promise.all([
      dto.unitId
        ? this.prisma.unit.findUnique({ where: { id: dto.unitId }, select: { id: true, name: true } })
        : Promise.resolve(null),
      dto.supplierId
        ? this.prisma.supplier.findUnique({
            where: { id: dto.supplierId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      this.prisma.stockInbound.aggregate({
        where: { warehouseId: warehouse.id },
        _max: { sortOrder: true },
      }),
      this.resolveInboundMaterial(warehouse.id, dto.materialId, dto.sku, name),
    ]);

    if (dto.unitId && !unit) throw new NotFoundException('Không tìm thấy đơn vị');
    if (dto.supplierId && !supplier) throw new NotFoundException('Không tìm thấy NCC');

    const sortOrder = (last._max.sortOrder ?? 0) + 1;
    const unitName = dto.unitName?.trim() || unit?.name || 'viên';
    const receivedAt = new Date(`${dto.receivedAt.slice(0, 10)}T00:00:00.000Z`);

    if (!existing) {
      throw new BadRequestException(
        'Chọn NVL đã có ở Cấu hình giá sản phẩm. Không tạo tên hàng mới từ kho nhập.',
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const material = existing;

      const row = await tx.stockInbound.create({
        data: {
          warehouseId: warehouse.id,
          materialId: material.id,
          sortOrder,
          receivedAt,
          name,
          sku: dto.sku?.trim() || material.sku || null,
          unitId: unit?.id ?? null,
          unitName,
          qty,
          stockUnitPrice: prices.stock,
          unitPrice: prices.inbound,
          amount,
          note: dto.note?.trim() || null,
          supplierSku: dto.supplierSku?.trim() || null,
          supplierId: supplier?.id ?? null,
          supplierName: dto.supplierName?.trim() || supplier?.name || null,
          applyToStock,
        },
        include: {
          unit: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          material: { select: { id: true, sku: true } },
        },
      });

      await this.recomputeStockBalance(tx, warehouse.id, material.id);

      return row;
    });

    this.bustWarehouseCaches(code);
    return this.toInboundRow(created);
  }

  async updateInbound(code: string, inboundId: string, dto: CreateInboundDto) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const inbound = await this.prisma.stockInbound.findFirst({
      where: { id: inboundId, warehouseId: warehouse.id },
      select: {
        id: true,
        materialId: true,
        applyToStock: true,
        qty: true,
        amount: true,
      },
    });
    if (!inbound) throw new NotFoundException('Không tìm thấy dòng nhập kho');

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên hàng không được trống');

    const qty = new Prisma.Decimal(dto.qty);
    const prices = exclusivePrices(dto.stockUnitPrice, dto.unitPrice);
    const amount = qty.mul(prices.unit).toDecimalPlaces(2);
    const sku = dto.sku?.trim() || null;

    const [unit, supplier] = await Promise.all([
      dto.unitId
        ? this.prisma.unit.findUnique({ where: { id: dto.unitId }, select: { id: true, name: true } })
        : Promise.resolve(null),
      dto.supplierId
        ? this.prisma.supplier.findUnique({
            where: { id: dto.supplierId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
    ]);
    if (dto.unitId && !unit) throw new NotFoundException('Không tìm thấy đơn vị');
    if (dto.supplierId && !supplier) throw new NotFoundException('Không tìm thấy NCC');

    if (sku && inbound.materialId) {
      const clash = await this.prisma.material.findFirst({
        where: {
          warehouseId: warehouse.id,
          sku,
          isActive: true,
          NOT: { id: inbound.materialId },
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException('Mã NVL đã tồn tại trong kho này');
    }

    const receivedAt = new Date(`${dto.receivedAt.slice(0, 10)}T00:00:00.000Z`);
    const unitName = dto.unitName?.trim() || unit?.name || 'viên';

    const updated = await this.prisma.$transaction(async (tx) => {
      let materialId = inbound.materialId;
      if (!materialId) {
        const ensured = await this.ensureMaterialInTx(tx, warehouse, name, sku, unit);
        materialId = ensured.id;
      } else {
        await tx.material.update({
          where: { id: materialId },
          data: {
            name,
            sku,
            ...(unit?.id ? { unitId: unit.id } : {}),
          },
        });
        await this.syncMaterialLines(tx, materialId, {
          name,
          sku,
          unitId: unit?.id,
          unitName,
        });
      }

      const row = await tx.stockInbound.update({
        where: { id: inbound.id },
        data: {
          materialId,
          receivedAt,
          name,
          sku,
          unitId: unit?.id ?? null,
          unitName,
          qty,
          stockUnitPrice: prices.stock,
          unitPrice: prices.inbound,
          amount,
          note: dto.note?.trim() || null,
          supplierSku: dto.supplierSku?.trim() || null,
          supplierId: supplier?.id ?? null,
          supplierName: dto.supplierName?.trim() || supplier?.name || null,
        },
        include: {
          unit: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          material: { select: { id: true, sku: true } },
        },
      });

      await this.recomputeStockBalance(tx, warehouse.id, materialId);

      return row;
    });

    this.bustWarehouseCaches(code);
    return this.toInboundRow(updated);
  }

  async deleteInbound(code: string, inboundId: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const inbound = await this.prisma.stockInbound.findFirst({
      where: { id: inboundId, warehouseId: warehouse.id },
      select: { id: true, materialId: true, qty: true, unitPrice: true },
    });
    if (!inbound) throw new NotFoundException('Không tìm thấy dòng nhập kho');

    await this.prisma.$transaction(async (tx) => {
      if (inbound.materialId) {
        await this.assertDeleteKeepsStockNonNegative(
          tx,
          warehouse.id,
          inbound.materialId,
          inbound.qty,
          new Prisma.Decimal(0),
        );
      }
      await tx.stockInbound.delete({ where: { id: inbound.id } });
      if (inbound.materialId) {
        if (!inbound.unitPrice.isZero()) {
          const leftover = await tx.stockInbound.aggregate({
            where: {
              warehouseId: warehouse.id,
              materialId: inbound.materialId,
              unitPrice: inbound.unitPrice,
              qty: { gt: 0 },
            },
            _sum: { qty: true },
          });
          if ((leftover._sum.qty ?? new Prisma.Decimal(0)).isZero()) {
            await tx.stockOutbound.deleteMany({
              where: {
                warehouseId: warehouse.id,
                materialId: inbound.materialId,
                inboundUnitPrice: inbound.unitPrice,
                OR: [{ applyToStock: false }, { qty: 0 }],
              },
            });
          }
        }
        await this.recomputeStockBalance(tx, warehouse.id, inbound.materialId);
      }
    });

    this.bustWarehouseCaches(code);
    return { success: true };
  }

  async listOutbounds(code: string) {
    const cacheKey = `outbounds:${code}`;
    const cached = this.cache.get<{
      warehouse: { id: string; code: string; name: string; shortName: string };
      totals: { qty: string; amount: string };
      items: ReturnType<InventoryService['toOutboundRow']>[];
    }>(cacheKey);
    if (cached) return cached;
    const payload = await this.loadOutbounds(code);
    this.cache.set(cacheKey, payload, STOCK_TTL_MS);
    return payload;
  }

  private async loadOutbounds(code: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true, name: true, shortName: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const [rows, layerMap] = await Promise.all([
      this.prisma.stockOutbound.findMany({
        where: { warehouseId: warehouse.id, applyToStock: true, qty: { gt: 0 } },
        orderBy: [{ issuedAt: 'asc' }, { sortOrder: 'asc' }],
        include: {
          unit: { select: { id: true, name: true } },
          material: { select: { id: true, sku: true } },
        },
      }),
      this.fullLayersByMaterial(warehouse.id),
    ]);

    const zero = new Prisma.Decimal(0);
    const totals = rows.reduce(
      (acc, row) => ({
        qty: acc.qty.add(row.qty),
        amount: acc.amount.add(
          row.amount.gt(0) ? row.amount : row.qty.mul(row.inboundUnitPrice).toDecimalPlaces(2),
        ),
      }),
      { qty: zero, amount: zero },
    );

    return {
      warehouse,
      totals: { qty: decStr(totals.qty), amount: decStr(totals.amount) },
      items: rows.map((row) => {
        const layers = row.materialId ? layerMap.get(row.materialId) ?? [] : [];
        const takes = pullFifoTakes(layers, row.qty);
        return this.toOutboundRow(row, takes);
      }),
    };
  }

  async createOutbound(code: string, dto: CreateOutboundDto) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên hàng không được trống');

    const qty = new Prisma.Decimal(dto.qty);
    const applyToStock = dto.applyToStock !== false;

    const [unit, existing] = await Promise.all([
      dto.unitId
        ? this.prisma.unit.findUnique({ where: { id: dto.unitId }, select: { id: true, name: true } })
        : Promise.resolve(null),
      this.resolveInboundMaterial(warehouse.id, dto.materialId, dto.sku, name),
    ]);

    if (dto.unitId && !unit) throw new NotFoundException('Không tìm thấy đơn vị');

    const unitName = dto.unitName?.trim() || unit?.name || 'viên';
    const issuedAt = new Date(`${dto.issuedAt.slice(0, 10)}T00:00:00.000Z`);

    if (!existing) {
      throw new BadRequestException(
        'Chọn NVL đã có ở Cấu hình giá sản phẩm. Không tạo tên hàng mới từ kho xuất.',
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const material = existing;
      await this.assertEnoughStock(tx, warehouse.id, material.id, qty);
      const lotUnit = await this.resolveMoveUnit(tx, material.id, unit);
      if (!lotUnit) {
        throw new BadRequestException('Thiếu đơn vị tính để ghi phiếu xuất');
      }
      return this.applyFifoOutbound(tx, {
        warehouseId: warehouse.id,
        material: { id: material.id, name, sku: material.sku },
        unit: lotUnit,
        unitName,
        issuedAt,
        qty,
        note: dto.note?.trim() || null,
        issuedBy: dto.issuedBy?.trim() || null,
        receivedBy: dto.receivedBy?.trim() || null,
        applyToStock,
      });
    });

    this.bustWarehouseCaches(code);
    return this.toOutboundRow(created);
  }

  async updateOutbound(code: string, outboundId: string, dto: CreateOutboundDto) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const outbound = await this.prisma.stockOutbound.findFirst({
      where: { id: outboundId, warehouseId: warehouse.id },
      select: {
        id: true,
        materialId: true,
        applyToStock: true,
        qty: true,
        amount: true,
      },
    });
    if (!outbound) throw new NotFoundException('Không tìm thấy dòng xuất kho');

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên hàng không được trống');

    const qty = new Prisma.Decimal(dto.qty);
    const sku = dto.sku?.trim() || null;

    const unit = dto.unitId
      ? await this.prisma.unit.findUnique({
          where: { id: dto.unitId },
          select: { id: true, name: true },
        })
      : null;
    if (dto.unitId && !unit) throw new NotFoundException('Không tìm thấy đơn vị');

    if (sku && outbound.materialId) {
      const clash = await this.prisma.material.findFirst({
        where: {
          warehouseId: warehouse.id,
          sku,
          isActive: true,
          NOT: { id: outbound.materialId },
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException('Mã NVL đã tồn tại trong kho này');
    }

    const issuedAt = new Date(`${dto.issuedAt.slice(0, 10)}T00:00:00.000Z`);
    const unitName = dto.unitName?.trim() || unit?.name || 'viên';

    const updated = await this.prisma.$transaction(async (tx) => {
      let materialId = outbound.materialId;
      if (!materialId) {
        const ensured = await this.ensureMaterialInTx(tx, warehouse, name, sku, unit);
        materialId = ensured.id;
      } else {
        await tx.material.update({
          where: { id: materialId },
          data: {
            name,
            sku,
            ...(unit?.id ? { unitId: unit.id } : {}),
          },
        });
        await this.syncMaterialLines(tx, materialId, {
          name,
          sku,
          unitId: unit?.id,
          unitName,
        });
      }

      await this.assertEnoughStock(tx, warehouse.id, materialId, qty, outbound.id);
      const quote = await this.quoteFifo(tx, warehouse.id, materialId, qty, outbound.id);

      const row = await tx.stockOutbound.update({
        where: { id: outbound.id },
        data: {
          materialId,
          issuedAt,
          name,
          sku,
          unitId: unit?.id ?? null,
          unitName,
          qty,
          stockUnitPrice: 0,
          inboundUnitPrice: quote.unitPrice,
          amount: quote.amount,
          note: dto.note?.trim() || null,
          issuedBy: dto.issuedBy?.trim() || null,
          receivedBy: dto.receivedBy?.trim() || null,
        },
        include: {
          unit: { select: { id: true, name: true } },
          material: { select: { id: true, sku: true } },
        },
      });

      await this.recomputeStockBalance(tx, warehouse.id, materialId);

      return row;
    });

    this.bustWarehouseCaches(code);
    return this.toOutboundRow(updated);
  }

  async deleteOutbound(code: string, outboundId: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const outbound = await this.prisma.stockOutbound.findFirst({
      where: { id: outboundId, warehouseId: warehouse.id },
      select: { id: true, materialId: true },
    });
    if (!outbound) throw new NotFoundException('Không tìm thấy dòng xuất kho');

    await this.prisma.$transaction(async (tx) => {
      await tx.stockOutbound.delete({ where: { id: outbound.id } });
      if (outbound.materialId) {
        await this.recomputeStockBalance(tx, warehouse.id, outbound.materialId);
      }
    });

    this.bustWarehouseCaches(code);
    return { success: true };
  }

  private async assertDeleteKeepsStockNonNegative(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string,
    removeInQty: Prisma.Decimal,
    removeOutQty: Prisma.Decimal,
  ) {
    const zero = new Prisma.Decimal(0);
    const [balance, inbound, outbound] = await Promise.all([
      tx.stockBalance.findUnique({
        where: { materialId },
        select: { openingQty: true },
      }),
      tx.stockInbound.aggregate({
        where: { warehouseId, materialId },
        _sum: { qty: true },
      }),
      tx.stockOutbound.aggregate({
        where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
        _sum: { qty: true },
      }),
    ]);
    const next = (balance?.openingQty ?? zero)
      .add(inbound._sum.qty ?? zero)
      .sub(removeInQty)
      .sub(outbound._sum.qty ?? zero)
      .add(removeOutQty);
    if (next.lt(0)) {
      throw new BadRequestException(
        'Không xóa được phiếu nhập: tồn kho sẽ âm vì đã xuất từ lô này.',
      );
    }
  }

  private async ensureMaterialInTx(
    tx: Prisma.TransactionClient,
    warehouse: { id: string; code: string },
    name: string,
    sku: string | null,
    unit: { id: string; name: string } | null,
  ) {
    const fallbackUnit =
      unit ??
      (await tx.unit.findUnique({
        where: { code: 'vien' },
        select: { id: true, name: true },
      }));
    if (!fallbackUnit) {
      throw new BadRequestException('Thiếu đơn vị tính để tạo NVL trên kho tồn');
    }
    const lastMat = await tx.material.aggregate({
      where: { warehouseId: warehouse.id, isActive: true },
      _max: { sortOrder: true },
    });
    const material = await tx.material.create({
      data: {
        warehouseId: warehouse.id,
        sku,
        name,
        unitId: fallbackUnit.id,
        classification: classificationOf(warehouse.code),
        sortOrder: (lastMat._max.sortOrder ?? 0) + 1,
      },
      select: { id: true, sku: true },
    });
    await tx.stockBalance.create({
      data: {
        warehouseId: warehouse.id,
        materialId: material.id,
      },
    });
    return material;
  }

  private async inboundSums(warehouseId: string, materialIds?: string[]) {
    const rows = await this.prisma.stockInbound.findMany({
      where: {
        warehouseId,
        materialId: materialIds ? { in: materialIds } : { not: null },
        applyToStock: true,
        qty: { gt: 0 },
      },
      select: { materialId: true, qty: true, unitPrice: true },
    });
    const zero = new Prisma.Decimal(0);
    const map = new Map<string, { qty: Prisma.Decimal; amount: Prisma.Decimal }>();
    for (const row of rows) {
      if (!row.materialId) continue;
      const prev = map.get(row.materialId) ?? { qty: zero, amount: zero };
      map.set(row.materialId, {
        qty: prev.qty.add(row.qty),
        amount: prev.amount.add(row.qty.mul(row.unitPrice).toDecimalPlaces(2)),
      });
    }
    return map;
  }

  private async firstInboundDates(warehouseId: string, materialIds?: string[]) {
    const grouped = await this.prisma.stockInbound.groupBy({
      by: ['materialId'],
      where: {
        warehouseId,
        materialId: materialIds ? { in: materialIds } : { not: null },
        qty: { gt: 0 },
      },
      _min: { receivedAt: true },
    });
    const map = new Map<string, Date>();
    for (const row of grouped) {
      if (!row.materialId || !row._min.receivedAt) continue;
      map.set(row.materialId, row._min.receivedAt);
    }
    return map;
  }

  private async outboundSums(warehouseId: string, materialIds?: string[]) {
    const rows = await this.prisma.stockOutbound.findMany({
      where: {
        warehouseId,
        materialId: materialIds ? { in: materialIds } : { not: null },
        applyToStock: true,
        qty: { gt: 0 },
      },
      select: { materialId: true, qty: true, inboundUnitPrice: true, amount: true },
    });
    const zero = new Prisma.Decimal(0);
    const map = new Map<string, { qty: Prisma.Decimal; amount: Prisma.Decimal }>();
    for (const row of rows) {
      if (!row.materialId) continue;
      const line = row.amount.gt(0)
        ? row.amount
        : row.qty.mul(row.inboundUnitPrice).toDecimalPlaces(2);
      const prev = map.get(row.materialId) ?? { qty: zero, amount: zero };
      map.set(row.materialId, {
        qty: prev.qty.add(row.qty),
        amount: prev.amount.add(line),
      });
    }
    return map;
  }

  private async resolveInboundMaterial(
    warehouseId: string,
    materialId?: string | null,
    sku?: string | null,
    name?: string,
  ) {
    if (materialId) {
      return this.prisma.material.findFirst({
        where: { id: materialId, warehouseId, isActive: true },
        select: { id: true, sku: true },
      });
    }
    if (sku?.trim()) {
      const bySku = await this.prisma.material.findFirst({
        where: { warehouseId, sku: sku.trim(), isActive: true },
        select: { id: true, sku: true },
      });
      if (bySku) return bySku;
    }
    if (name?.trim()) {
      return this.prisma.material.findFirst({
        where: { warehouseId, name: name.trim(), isActive: true },
        select: { id: true, sku: true },
      });
    }
    return null;
  }

  private toInboundRow(row: {
    id: string;
    sortOrder: number;
    receivedAt: Date;
    name: string;
    sku: string | null;
    unitName: string;
    unitId: string | null;
    qty: Prisma.Decimal;
    stockUnitPrice: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    amount: Prisma.Decimal;
    note: string | null;
    supplierSku: string | null;
    supplierId: string | null;
    supplierName: string | null;
    materialId: string | null;
    unit?: { id: string; name: string } | null;
    supplier?: { id: string; name: string } | null;
    material?: { id: string; sku: string | null } | null;
  }) {
    return {
      id: row.id,
      stt: row.sortOrder,
      receivedAt: row.receivedAt.toISOString().slice(0, 10),
      name: row.name,
      sku: row.sku,
      unit: row.unit?.name ?? row.unitName,
      unitId: row.unitId,
      qty: decStr(row.qty),
      stockUnitPrice: decStr(row.stockUnitPrice),
      unitPrice: decStr(row.unitPrice),
      amount: decStr(row.amount),
      note: row.note,
      supplierSku: row.supplierSku,
      supplierId: row.supplierId,
      supplierName: row.supplierName ?? row.supplier?.name ?? null,
      materialId: row.materialId,
    };
  }

  private toOutboundRow(row: {
    id: string;
    sortOrder: number;
    issuedAt: Date;
    name: string;
    sku: string | null;
    unitName: string;
    unitId: string | null;
    qty: Prisma.Decimal;
    stockUnitPrice: Prisma.Decimal;
    inboundUnitPrice: Prisma.Decimal;
    amount: Prisma.Decimal;
    note: string | null;
    issuedBy: string | null;
    receivedBy: string | null;
    materialId: string | null;
    unit?: { id: string; name: string } | null;
    material?: { id: string; sku: string | null } | null;
  },
    takes?: PriceTake[],
  ) {
    return {
      id: row.id,
      stt: row.sortOrder,
      issuedAt: row.issuedAt.toISOString().slice(0, 10),
      name: row.name,
      sku: row.sku,
      unit: row.unit?.name ?? row.unitName,
      unitId: row.unitId,
      qty: decStr(row.qty),
      stockUnitPrice: decStr(row.stockUnitPrice),
      inboundUnitPrice: decStr(row.inboundUnitPrice),
      amount: decStr(row.amount),
      note: row.note,
      issuedBy: row.issuedBy,
      receivedBy: row.receivedBy,
      materialId: row.materialId,
      priceBreakdown: (takes ?? []).map((take) => ({
        qty: decStr(take.qty),
        unitPrice: decStr(take.unitPrice),
        source: take.kind,
      })),
    };
  }

  private assertLookups(
    shapeId?: string | null,
    colorId?: string | null,
    materialTypeId?: string | null,
  ) {
    return Promise.all([
      this.assertLookup('shape', shapeId),
      this.assertLookup('color', colorId),
      this.assertLookup('materialType', materialTypeId),
    ]);
  }

  private async assertLookup(
    kind: 'shape' | 'color' | 'materialType',
    id?: string | null,
  ) {
    if (!id) return;
    const found =
      kind === 'shape'
        ? await this.prisma.shape.findUnique({ where: { id }, select: { id: true } })
        : kind === 'color'
          ? await this.prisma.color.findUnique({ where: { id }, select: { id: true } })
          : await this.prisma.materialType.findUnique({
              where: { id },
              select: { id: true },
            });
    if (!found) throw new NotFoundException('Danh mục không hợp lệ');
  }

  private toStockRow(
    m: MaterialStock,
    inbound?: { qty: Prisma.Decimal; amount: Prisma.Decimal },
    outbound?: { qty: Prisma.Decimal; amount: Prisma.Decimal },
    firstInboundAt?: Date,
    layers?: PriceLayer[],
  ) {
    const b = m.balance;
    const nxt = nxtFigures(
      b?.openingQty ?? new Prisma.Decimal(0),
      b?.openingAmount ?? new Prisma.Decimal(0),
      inbound,
      outbound,
    );
    const av = availabilityOf(nxt.qty, m.reorderPoint);
    const stockedAt = (firstInboundAt ?? m.createdAt).toISOString().slice(0, 10);
    return {
      id: m.id,
      stt: m.sortOrder,
      locationCode: m.locationCode,
      sku: m.sku,
      shapeId: m.shapeId,
      shape: m.shape?.name ?? null,
      colorId: m.colorId,
      color: m.color?.name ?? null,
      name: m.name,
      note: m.note,
      unitId: m.unitId,
      unit: m.unit.name,
      openingQty: decStr(b?.openingQty),
      openingAmount: decStr(b?.openingAmount),
      stockUnitPrice: decStr(b?.stockUnitPrice),
      stockedAt,
      inQty: decStr(nxt.inQty),
      inAmount: decStr(nxt.inAmount),
      outQty: decStr(nxt.outQty),
      outAmount: decStr(nxt.outAmount),
      qty: decStr(nxt.qty),
      amount: decStr(nxt.amount),
      priceLayers: (layers ?? []).map((layer) => ({
        qty: decStr(layer.remaining),
        unitPrice: decStr(layer.unitPrice),
        source: layer.kind,
      })),
      materialTypeId: m.materialTypeId,
      materialType: m.materialType?.name ?? null,
      classificationCode: m.classification,
      classification: CLASS_LABEL[m.classification] ?? m.classification,
      availability: av.code,
      availabilityLabel: av.label,
    };
  }

  private bustWarehouseCaches(code: string) {
    this.cache.delete(`stock:${code}`);
    this.cache.delete(`inbounds:${code}`);
    this.cache.delete(`outbounds:${code}`);
  }

  /** Tồn kho SL/TT = đầu kỳ + nhập − xuất. */
  private async recomputeStockBalance(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string | null,
  ) {
    if (!materialId) return;
    const zero = new Prisma.Decimal(0);
    const [balance, inboundRows, outboundRows] = await Promise.all([
      tx.stockBalance.findUnique({
        where: { materialId },
        select: { openingQty: true, openingAmount: true },
      }),
      tx.stockInbound.findMany({
        where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
        select: { qty: true, unitPrice: true },
      }),
      tx.stockOutbound.findMany({
        where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
        select: { qty: true, inboundUnitPrice: true, amount: true },
      }),
    ]);
    const inbound = inboundRows.reduce(
      (acc, row) => ({
        qty: acc.qty.add(row.qty),
        amount: acc.amount.add(row.qty.mul(row.unitPrice).toDecimalPlaces(2)),
      }),
      { qty: zero, amount: zero },
    );
    const outbound = outboundRows.reduce(
      (acc, row) => ({
        qty: acc.qty.add(row.qty),
        amount: acc.amount.add(
          row.amount.gt(0) ? row.amount : row.qty.mul(row.inboundUnitPrice).toDecimalPlaces(2),
        ),
      }),
      { qty: zero, amount: zero },
    );
    const nxt = nxtFigures(
      balance?.openingQty ?? zero,
      balance?.openingAmount ?? zero,
      inbound,
      outbound,
    );
    await tx.stockBalance.upsert({
      where: { materialId },
      create: {
        warehouseId,
        materialId,
        openingQty: balance?.openingQty ?? zero,
        openingAmount: balance?.openingAmount ?? zero,
        inQty: nxt.inQty,
        inAmount: nxt.inAmount,
        outQty: nxt.outQty,
        outAmount: nxt.outAmount,
        qty: nxt.qty,
        amount: nxt.amount,
      },
      update: {
        inQty: nxt.inQty,
        inAmount: nxt.inAmount,
        outQty: nxt.outQty,
        outAmount: nxt.outAmount,
        qty: nxt.qty,
        amount: nxt.amount,
      },
    });
  }

  private async syncMaterialLines(
    tx: Prisma.TransactionClient,
    materialId: string,
    patch: {
      name: string;
      sku: string | null;
      unitId?: string | null;
      unitName?: string;
    },
  ) {
    const data = {
      name: patch.name,
      sku: patch.sku,
      ...(patch.unitId ? { unitId: patch.unitId } : {}),
      ...(patch.unitName ? { unitName: patch.unitName } : {}),
    };
    await Promise.all([
      tx.stockInbound.updateMany({ where: { materialId }, data }),
      tx.stockOutbound.updateMany({ where: { materialId }, data }),
    ]);
  }

  private async availableOnHand(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string,
    exceptOutboundId?: string,
  ) {
    const zero = new Prisma.Decimal(0);
    const [balance, inbound, outbound] = await Promise.all([
      tx.stockBalance.findUnique({
        where: { materialId },
        select: { openingQty: true },
      }),
      tx.stockInbound.aggregate({
        where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
        _sum: { qty: true },
      }),
      tx.stockOutbound.aggregate({
        where: {
          warehouseId,
          materialId,
          applyToStock: true,
          qty: { gt: 0 },
          ...(exceptOutboundId ? { NOT: { id: exceptOutboundId } } : {}),
        },
        _sum: { qty: true },
      }),
    ]);
    return (balance?.openingQty ?? zero)
      .add(inbound._sum.qty ?? zero)
      .sub(outbound._sum.qty ?? zero);
  }

  private async assertEnoughStock(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string,
    qty: Prisma.Decimal,
    exceptOutboundId?: string,
  ) {
    if (qty.lte(0)) {
      throw new BadRequestException('Số lượng xuất phải lớn hơn 0');
    }
    const available = await this.availableOnHand(tx, warehouseId, materialId, exceptOutboundId);
    if (qty.gt(available)) {
      throw new BadRequestException(
        `Không đủ tồn để xuất (sẵn có ${decStr(available)}, xuất ${decStr(qty)})`,
      );
    }
  }

  /** Xuất FIFO: hết lớp giá cũ (đầu kỳ) rồi mới đến từng lô nhập. */
  private async applyFifoOutbound(
    tx: Prisma.TransactionClient,
    params: {
      warehouseId: string;
      material: { id: string; name: string; sku: string | null };
      unit: { id: string; name: string };
      unitName: string;
      issuedAt: Date;
      qty: Prisma.Decimal;
      note: string | null;
      issuedBy: string | null;
      receivedBy: string | null;
      applyToStock: boolean;
    },
  ) {
    const quote = await this.quoteFifo(tx, params.warehouseId, params.material.id, params.qty);
    const last = await tx.stockOutbound.aggregate({
      where: { warehouseId: params.warehouseId },
      _max: { sortOrder: true },
    });
    const row = await tx.stockOutbound.create({
      data: {
        warehouseId: params.warehouseId,
        materialId: params.material.id,
        sortOrder: (last._max.sortOrder ?? 0) + 1,
        issuedAt: params.issuedAt,
        name: params.material.name,
        sku: params.material.sku,
        unitId: params.unit.id,
        unitName: params.unitName,
        qty: params.qty,
        stockUnitPrice: 0,
        inboundUnitPrice: quote.unitPrice,
        amount: quote.amount,
        note: params.note,
        issuedBy: params.issuedBy,
        receivedBy: params.receivedBy,
        applyToStock: params.applyToStock,
      },
      include: {
        unit: { select: { id: true, name: true } },
        material: { select: { id: true, sku: true } },
      },
    });
    await this.recomputeStockBalance(tx, params.warehouseId, params.material.id);
    return row;
  }

  private async quoteFifo(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string,
    qty: Prisma.Decimal,
    exceptOutboundId?: string,
  ) {
    const layers = await this.listPriceLayers(tx, warehouseId, materialId, exceptOutboundId);
    return takeFifo(layers, qty);
  }

  private async fullLayersByMaterial(warehouseId: string) {
    const [balances, inbounds] = await Promise.all([
      this.prisma.stockBalance.findMany({
        where: { warehouseId },
        select: {
          materialId: true,
          openingQty: true,
          openingAmount: true,
          stockUnitPrice: true,
        },
      }),
      this.prisma.stockInbound.findMany({
        where: { warehouseId, applyToStock: true, qty: { gt: 0 } },
        orderBy: [{ receivedAt: 'asc' }, { sortOrder: 'asc' }],
        select: { materialId: true, qty: true, unitPrice: true },
      }),
    ]);
    const inboundByMaterial = new Map<string, { qty: Prisma.Decimal; unitPrice: Prisma.Decimal }[]>();
    for (const row of inbounds) {
      if (!row.materialId) continue;
      const list = inboundByMaterial.get(row.materialId) ?? [];
      list.push({ qty: row.qty, unitPrice: row.unitPrice });
      inboundByMaterial.set(row.materialId, list);
    }
    const map = new Map<string, PriceLayer[]>();
    for (const balance of balances) {
      map.set(balance.materialId, buildPriceLayers(balance, inboundByMaterial.get(balance.materialId) ?? []));
    }
    return map;
  }

  private async remainingLayersByMaterial(warehouseId: string) {
    const [layerMap, outboundSums] = await Promise.all([
      this.fullLayersByMaterial(warehouseId),
      this.prisma.stockOutbound.groupBy({
        by: ['materialId'],
        where: { warehouseId, applyToStock: true, qty: { gt: 0 } },
        _sum: { qty: true },
      }),
    ]);
    const consumedByMaterial = new Map<string, Prisma.Decimal>();
    for (const row of outboundSums) {
      if (!row.materialId) continue;
      consumedByMaterial.set(row.materialId, row._sum.qty ?? new Prisma.Decimal(0));
    }
    const map = new Map<string, PriceLayer[]>();
    for (const [materialId, layers] of layerMap) {
      map.set(
        materialId,
        consumeLayers(layers, consumedByMaterial.get(materialId) ?? new Prisma.Decimal(0)),
      );
    }
    return map;
  }

  private async listPriceLayers(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string,
    exceptOutboundId?: string,
  ) {
    const [balance, inbounds, outbound] = await Promise.all([
      tx.stockBalance.findUnique({
        where: { materialId },
        select: { openingQty: true, openingAmount: true, stockUnitPrice: true },
      }),
      tx.stockInbound.findMany({
        where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
        orderBy: [{ receivedAt: 'asc' }, { sortOrder: 'asc' }],
        select: { qty: true, unitPrice: true },
      }),
      tx.stockOutbound.aggregate({
        where: {
          warehouseId,
          materialId,
          applyToStock: true,
          qty: { gt: 0 },
          ...(exceptOutboundId ? { NOT: { id: exceptOutboundId } } : {}),
        },
        _sum: { qty: true },
      }),
    ]);
    return consumeLayers(
      buildPriceLayers(balance, inbounds),
      outbound._sum.qty ?? new Prisma.Decimal(0),
    );
  }

  private async resolveMoveUnit(
    tx: Prisma.TransactionClient,
    materialId: string,
    unit: { id: string; name: string } | null,
  ) {
    if (unit) return unit;
    const material = await tx.material.findUnique({
      where: { id: materialId },
      select: { unit: { select: { id: true, name: true } } },
    });
    return material?.unit ?? null;
  }
}

function classificationOf(warehouseCode: string): MaterialClass {
  if (warehouseCode === 'nvl-tieu-hao') return MaterialClass.CONSUMABLE;
  if (warehouseCode === 'ban-thanh-pham') return MaterialClass.SEMI_FINISHED;
  return MaterialClass.RAW_MATERIAL;
}

function exclusivePrices(stockUnitPrice?: string, inboundUnitPrice?: string) {
  const stock = new Prisma.Decimal(stockUnitPrice || 0);
  const inbound = new Prisma.Decimal(inboundUnitPrice || 0);
  if (!stock.isZero() && !inbound.isZero()) {
    throw new BadRequestException('Chỉ nhập một trong hai: đơn giá tồn hoặc đơn giá nhập');
  }
  return { stock, inbound, unit: stock.isZero() ? inbound : stock };
}

function buildPriceLayers(
  balance:
    | {
        openingQty: Prisma.Decimal;
        openingAmount: Prisma.Decimal;
        stockUnitPrice?: Prisma.Decimal;
      }
    | null
    | undefined,
  inbounds: { qty: Prisma.Decimal; unitPrice: Prisma.Decimal }[],
): PriceLayer[] {
  const zero = new Prisma.Decimal(0);
  const layers: PriceLayer[] = [];
  const openingQty = balance?.openingQty ?? zero;
  if (openingQty.gt(0)) {
    const fromStock = balance?.stockUnitPrice;
    const openingPrice =
      fromStock && !fromStock.isZero()
        ? fromStock
        : (balance?.openingAmount ?? zero).div(openingQty).toDecimalPlaces(2);
    layers.push({ kind: 'opening', unitPrice: openingPrice, remaining: openingQty });
  }
  for (const row of inbounds) {
    if (row.qty.lte(0)) continue;
    const last = layers[layers.length - 1];
    const canMerge =
      last &&
      last.kind === 'inbound' &&
      last.unitPrice.eq(row.unitPrice);
    if (canMerge) last.remaining = last.remaining.add(row.qty);
    else layers.push({ kind: 'inbound', unitPrice: row.unitPrice, remaining: row.qty });
  }
  return layers;
}

function consumeLayers(layers: PriceLayer[], consumed: Prisma.Decimal): PriceLayer[] {
  let left = consumed;
  for (const layer of layers) {
    if (left.lte(0)) break;
    const take = layer.remaining.lt(left) ? layer.remaining : left;
    layer.remaining = layer.remaining.sub(take);
    left = left.sub(take);
  }
  return layers.filter((layer) => layer.remaining.gt(0));
}

function pullFifoTakes(layers: PriceLayer[], qty: Prisma.Decimal): PriceTake[] {
  const takes: PriceTake[] = [];
  let need = qty;
  for (const layer of layers) {
    if (need.lte(0)) break;
    if (layer.remaining.lte(0)) continue;
    const take = layer.remaining.lt(need) ? layer.remaining : need;
    takes.push({ kind: layer.kind, qty: take, unitPrice: layer.unitPrice });
    layer.remaining = layer.remaining.sub(take);
    need = need.sub(take);
  }
  return takes;
}

function takeFifo(layers: PriceLayer[], qty: Prisma.Decimal) {
  const zero = new Prisma.Decimal(0);
  const takes = pullFifoTakes(layers, qty);
  const taken = takes.reduce((sum, take) => sum.add(take.qty), zero);
  if (taken.lt(qty)) {
    throw new BadRequestException('Không đủ tồn để xuất theo lớp giá.');
  }
  const amount = takes.reduce(
    (sum, take) => sum.add(take.qty.mul(take.unitPrice).toDecimalPlaces(2)),
    zero,
  );
  const samePrice =
    takes.length > 0 && takes.every((take) => take.unitPrice.eq(takes[0].unitPrice));
  return {
    amount,
    unitPrice: samePrice ? takes[0].unitPrice : zero,
  };
}

function nxtFigures(
  openingQty: Prisma.Decimal,
  openingAmount: Prisma.Decimal,
  inbound?: { qty: Prisma.Decimal; amount: Prisma.Decimal },
  outbound?: { qty: Prisma.Decimal; amount: Prisma.Decimal },
) {
  const zero = new Prisma.Decimal(0);
  const inQty = inbound?.qty ?? zero;
  const inAmount = inbound?.amount ?? zero;
  const outQty = outbound?.qty ?? zero;
  const outAmount = outbound?.amount ?? zero;
  return {
    inQty,
    inAmount,
    outQty,
    outAmount,
    qty: openingQty.add(inQty).sub(outQty),
    amount: openingAmount.add(inAmount).sub(outAmount),
  };
}

function openingMoney(qty: Prisma.Decimal, unitPrice: Prisma.Decimal) {
  return qty.mul(unitPrice).toDecimalPlaces(2);
}
