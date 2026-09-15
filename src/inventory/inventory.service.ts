import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MaterialClass, MetalKind, OtherClassKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InflightMap, TtlCache } from '../util/ttl-cache';
import { availabilityOf, CLASS_LABEL, METAL_KIND_LABEL, decStr } from '../util/money';
import { allocateMaterialSku } from '../util/material-sku';
import { slugFromName } from '../util/slug';
import type { AuthUserPayload } from '../auth/types';
import { canSeeWarehouse } from '../auth/screens';
import { CreateInboundDto } from './dto/inbound.dto';
import { CreateOutboundDto } from './dto/outbound.dto';
import { CreateStockDto, UpdateStockDto } from './dto/update-stock.dto';

const LOOKUPS_TTL_MS = 10 * 60_000;
const USERS_TTL_MS = 60_000;
const WAREHOUSES_TTL_MS = 2 * 60_000;
const STOCK_TTL_MS = 60_000;

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
  otherClassId: true,
  bodyMetalId: true,
  productKindId: true,
  shapeId: true,
  colorId: true,
  classification: true,
  metalKind: true,
  note: true,
  sortOrder: true,
  reorderPoint: true,
  createdAt: true,
  unit: { select: { id: true, name: true } },
  materialType: { select: { id: true, name: true } },
  otherClass: { select: { id: true, name: true, parentId: true, parent: { select: { id: true, code: true, name: true } } } },
  bodyMetal: { select: { id: true, name: true } },
  productKind: { select: { id: true, name: true } },
  shape: { select: { id: true, name: true } },
  color: { select: { id: true, name: true } },
  balance: {
    select: {
      openingQty: true,
      openingAmount: true,
      stockUnitPrice: true,
      inQty: true,
      inAmount: true,
      outQty: true,
      outAmount: true,
      qty: true,
      amount: true,
    },
  },
} as const;

const inboundListSelect = {
  id: true,
  sortOrder: true,
  receivedAt: true,
  name: true,
  sku: true,
  unitName: true,
  unitId: true,
  qty: true,
  stockUnitPrice: true,
  unitPrice: true,
  amount: true,
  note: true,
  enteredBy: true,
  supplierSku: true,
  supplierId: true,
  supplierName: true,
  materialId: true,
  sourceOutboundId: true,
  sourceWarehouse: { select: { code: true, shortName: true } },
  unit: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  material: { select: { id: true, sku: true } },
} as const;

const outboundListSelect = {
  id: true,
  sortOrder: true,
  issuedAt: true,
  name: true,
  sku: true,
  unitName: true,
  unitId: true,
  qty: true,
  stockUnitPrice: true,
  inboundUnitPrice: true,
  amount: true,
  note: true,
  issuedBy: true,
  receivedBy: true,
  receivedByUserId: true,
  materialId: true,
  destInboundId: true,
  destWarehouse: { select: { code: true, shortName: true } },
  unit: { select: { id: true, name: true } },
  material: { select: { id: true, sku: true } },
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
  private readonly inflight = new InflightMap();

  constructor(private readonly prisma: PrismaService) {}

  async listWarehouses(user?: AuthUserPayload) {
    const warehouses = await this.cached('warehouses', WAREHOUSES_TTL_MS, () =>
      this.loadWarehouses(),
    );
    if (!user || user.roleCode === 'ADMIN') return warehouses;
    return warehouses
      .filter((warehouse) => canSeeWarehouse(user, warehouse.code))
      .map((warehouse) => ({
        ...warehouse,
        children: warehouse.children.filter((child) =>
          canSeeWarehouse(user, child.code),
        ),
      }));
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

  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get<T>(key);
    if (hit) return Promise.resolve(hit);
    return this.inflight.run(key, async () => {
      const again = this.cache.get<T>(key);
      if (again) return again;
      const value = await load();
      this.cache.set(key, value, ttlMs);
      return value;
    });
  }

  async listLookups() {
    const [catalog, users] = await Promise.all([
      this.cached('lookups', LOOKUPS_TTL_MS, async () => {
        const [units, materialTypes, shapes, colors, suppliers, otherClasses, bodyMetals, btpCategories, productKinds, consumableCategories] =
          await Promise.all([
          this.prisma.unit.findMany({
            select: lookupSelect,
            orderBy: { sortOrder: 'asc' },
          }),
          this.prisma.materialType.findMany({
            select: { ...lookupSelect, metalKind: true },
            orderBy: [{ sortOrder: 'asc' }],
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
          this.prisma.otherClass.findMany({
            where: { parent: { code: 'phan-loai-khac' } },
            select: lookupSelect,
            orderBy: { sortOrder: 'asc' },
          }),
          this.listCatalogChildrenByParent('chat-lieu'),
          this.listCatalogChildrenByParent('danh-muc-btp'),
          this.listCatalogChildrenByParent('phan-loai-san-pham'),
          this.prisma.otherClass.findMany({
            where: { parentId: null, code: { in: ['ccdc', 'nvl-phu', 'nvl-chinh'] } },
            select: lookupSelect,
            orderBy: { sortOrder: 'asc' },
          }),
        ]);
        return {
          units,
          materialTypes,
          shapes,
          colors,
          suppliers,
          otherClasses,
          bodyMetals,
          btpCategories,
          productKinds,
          consumableCategories,
        };
      }),
      this.cached('lookups:users', USERS_TTL_MS, () =>
        this.prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, username: true, fullName: true },
          orderBy: { fullName: 'asc' },
        }),
      ),
    ]);
    return { ...catalog, users };
  }

  async listStock(code: string) {
    return this.cached(`stock:${code}`, STOCK_TTL_MS, () => this.loadStock(code));
  }

  private async loadStock(code: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: warehouseSelect,
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');
    if (code === 'btp-cho-vao-da') {
      const waiting = await this.prisma.btpWaitingItem.count({
        where: { warehouseId: warehouse.id },
      });
      if (waiting) await this.importBtpWaitingToStock(warehouse);
    }

    const [materials, firstInboundMap, inboundLots, outboundConsumed] = await Promise.all([
      this.prisma.material.findMany({
        where: { warehouseId: warehouse.id, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: materialStockSelect,
      }),
      this.firstInboundDates(warehouse.id),
      this.prisma.stockInbound.findMany({
        where: {
          warehouseId: warehouse.id,
          materialId: { not: null },
          applyToStock: true,
          qty: { gt: 0 },
        },
        orderBy: [{ receivedAt: 'asc' }, { sortOrder: 'asc' }],
        select: { materialId: true, qty: true, unitPrice: true },
      }),
      this.prisma.stockOutbound.groupBy({
        by: ['materialId'],
        where: {
          warehouseId: warehouse.id,
          materialId: { not: null },
          applyToStock: true,
          qty: { gt: 0 },
        },
        _sum: { qty: true },
      }),
    ]);

    const zero = new Prisma.Decimal(0);
    const inboundByMaterial = new Map<string, { qty: Prisma.Decimal; unitPrice: Prisma.Decimal }[]>();
    for (const row of inboundLots) {
      if (!row.materialId) continue;
      const lots = inboundByMaterial.get(row.materialId) ?? [];
      lots.push({ qty: row.qty, unitPrice: row.unitPrice });
      inboundByMaterial.set(row.materialId, lots);
    }
    const consumedByMaterial = new Map<string, Prisma.Decimal>();
    for (const row of outboundConsumed) {
      if (!row.materialId) continue;
      consumedByMaterial.set(row.materialId, row._sum.qty ?? zero);
    }

    const items = materials.map((m) =>
      this.toStockRow(
        m,
        undefined,
        undefined,
        firstInboundMap.get(m.id),
        consumeLayers(
          buildPriceLayers(m.balance, inboundByMaterial.get(m.id) ?? []),
          consumedByMaterial.get(m.id) ?? zero,
        ),
      ),
    );
    const totals = materials.reduce(
      (acc, m) => {
        const nxt = nxtFromBalance(m.balance);
        return {
          openingQty: acc.openingQty.add(m.balance?.openingQty ?? 0),
          openingAmount: acc.openingAmount.add(m.balance?.openingAmount ?? 0),
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

    const [last] = await Promise.all([
      this.prisma.material.aggregate({
        where: { warehouseId: warehouse.id, isActive: true },
        _max: { sortOrder: true },
      }),
      this.assertLookups(
        dto.shapeId,
        dto.colorId,
        dto.materialTypeId,
        dto.bodyMetalId,
        dto.productKindId,
        dto.btpCategoryId,
      ),
    ]);

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
    await this.assertAssignableLocation(warehouse.id, dto.locationCode);
    const isBtp = warehouse.code === 'btp-cho-vao-da';
    const isConsumable = warehouse.code === 'nvl-tieu-hao';
    if (isConsumable) {
      await this.assertConsumableClass(dto.otherClassId);
      if (!dto.otherClassId) {
        throw new BadRequestException('Chọn danh mục');
      }
    }
    const otherClassId = isBtp
      ? dto.btpCategoryId || null
      : isConsumable
        ? dto.otherClassId || null
        : await this.resolveOtherClassId(dto.otherClassName);

    const created = await this.prisma.runTx(async (tx) => {
      const sku = await allocateMaterialSku(tx);
      const material = await tx.material.create({
        data: {
          warehouseId: warehouse.id,
          sku,
          name,
          locationCode: dto.locationCode?.trim() || null,
          unitId: dto.unitId,
          shapeId: dto.shapeId || null,
          colorId: dto.colorId || null,
          materialTypeId: isBtp || otherClassId ? null : dto.materialTypeId || null,
          otherClassId,
          bodyMetalId: dto.bodyMetalId || null,
          productKindId: dto.productKindId || null,
          classification: classificationOf(warehouse.code),
          metalKind: isBtp || otherClassId ? null : (dto.metalKind ?? defaultMetalKind(warehouse.code)),
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
    return this.toStockRow(
      created,
      undefined,
      undefined,
      undefined,
      consumeLayers(buildPriceLayers(created.balance, []), new Prisma.Decimal(0)),
    );
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

    let unitRow: { id: string; name: string } | null = null;
    if (dto.unitId) {
      unitRow = await this.prisma.unit.findUnique({
        where: { id: dto.unitId },
        select: { id: true, name: true },
      });
      if (!unitRow) throw new NotFoundException('Không tìm thấy đơn vị');
    }
    await this.assertLookups(
      dto.shapeId,
      dto.colorId,
      dto.materialTypeId,
      dto.bodyMetalId,
      dto.productKindId,
      dto.btpCategoryId,
    );

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

    if (dto.locationCode !== undefined) {
      await this.assertAssignableLocation(warehouse.id, dto.locationCode, material.id);
    }
    const otherClassId =
      dto.otherClassId !== undefined
        ? dto.otherClassId
        : dto.btpCategoryId !== undefined
          ? dto.btpCategoryId
          : dto.otherClassName === undefined
            ? undefined
            : await this.resolveOtherClassId(dto.otherClassName);
    if (dto.otherClassId !== undefined) {
      await this.assertConsumableClass(dto.otherClassId);
    }

    await this.prisma.runTx(async (tx) => {
      await tx.material.update({
        where: { id: material.id },
        data: {
          ...(dto.sortOrder != null ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.locationCode !== undefined
            ? { locationCode: dto.locationCode?.trim() || null }
            : {}),
          ...(dto.name != null ? { name: dto.name.trim() } : {}),
          ...(dto.unitId ? { unitId: dto.unitId } : {}),
          ...(dto.shapeId !== undefined ? { shapeId: dto.shapeId } : {}),
          ...(dto.colorId !== undefined ? { colorId: dto.colorId } : {}),
          ...(otherClassId
            ? { materialTypeId: null, otherClassId, metalKind: null }
            : {
                ...(dto.materialTypeId !== undefined
                  ? { materialTypeId: dto.materialTypeId }
                  : {}),
                ...(otherClassId !== undefined ? { otherClassId: null } : {}),
                ...(dto.metalKind !== undefined ? { metalKind: dto.metalKind } : {}),
              }),
          ...(dto.classification ? { classification: dto.classification } : {}),
          ...(dto.bodyMetalId !== undefined ? { bodyMetalId: dto.bodyMetalId } : {}),
          ...(dto.productKindId !== undefined ? { productKindId: dto.productKindId } : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
        },
      });

      if (dto.name != null || dto.unitId) {
        await this.syncMaterialLines(tx, material.id, {
          name: dto.name?.trim() || material.name,
          sku: material.sku,
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

    const [updated, inboundMap, outboundMap, firstInboundMap, layers] = await Promise.all([
      this.prisma.material.findUniqueOrThrow({
        where: { id: material.id },
        select: materialStockSelect,
      }),
      this.inboundSums(warehouse.id, [material.id]),
      this.outboundSums(warehouse.id, [material.id]),
      this.firstInboundDates(warehouse.id, [material.id]),
      this.listPriceLayers(this.prisma, warehouse.id, material.id),
    ]);
    this.bustWarehouseCaches(code);
    return this.toStockRow(
      updated,
      inboundMap.get(material.id),
      outboundMap.get(material.id),
      firstInboundMap.get(material.id),
      layers,
    );
  }

  async listInbounds(code: string) {
    return this.cached(`inbounds:${code}`, STOCK_TTL_MS, () => this.loadInbounds(code));
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
      select: inboundListSelect,
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

  async createInbound(code: string, dto: CreateInboundDto, actor: AuthUserPayload) {
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
      if (warehouse.code !== 'nvl-tieu-hao') {
        throw new BadRequestException(
          'Chọn NVL đã có ở Tồn. Không tạo tên hàng mới từ Nhập.',
        );
      }
      if (!dto.otherClassId) {
        throw new BadRequestException('Chọn danh mục');
      }
      await this.assertConsumableClass(dto.otherClassId);
    }

    if (dto.locationCode !== undefined) {
      await this.assertAssignableLocation(warehouse.id, dto.locationCode, existing?.id);
    }

    const created = await this.prisma.runTx(async (tx) => {
      const material = existing
        ? existing
        : await this.ensureMaterialInTx(tx, warehouse, name, unit, dto.otherClassId);
      if (existing && dto.locationCode !== undefined) {
        await tx.material.update({
          where: { id: material.id },
          data: { locationCode: dto.locationCode?.trim() || null },
        });
      }

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
          enteredBy: actorDisplayName(actor),
          supplierSku: dto.supplierSku?.trim() || null,
          supplierId: supplier?.id ?? null,
          supplierName: dto.supplierName?.trim() || supplier?.name || null,
          applyToStock,
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
        sourceOutboundId: true,
      },
    });
    if (!inbound) throw new NotFoundException('Không tìm thấy dòng nhập kho');
    if (inbound.sourceOutboundId) {
      throw new BadRequestException(
        'Phiếu nhập chuyển kho: sửa từ phiếu xuất ở kho nguồn.',
      );
    }

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên hàng không được trống');

    const qty = new Prisma.Decimal(dto.qty);
    const prices = exclusivePrices(dto.stockUnitPrice, dto.unitPrice);
    const amount = qty.mul(prices.unit).toDecimalPlaces(2);
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

    const receivedAt = new Date(`${dto.receivedAt.slice(0, 10)}T00:00:00.000Z`);
    const unitName = dto.unitName?.trim() || unit?.name || 'viên';
    if (dto.locationCode !== undefined) {
      await this.assertAssignableLocation(warehouse.id, dto.locationCode, inbound.materialId);
    }

    const updated = await this.prisma.runTx(async (tx) => {
      let materialId = inbound.materialId;
      let materialSku: string | null = null;
      if (!materialId) {
        const ensured = await this.ensureMaterialInTx(tx, warehouse, name, unit);
        materialId = ensured.id;
        materialSku = ensured.sku;
      } else {
        const current = await tx.material.update({
          where: { id: materialId },
          data: {
            name,
            ...(unit?.id ? { unitId: unit.id } : {}),
            ...(dto.locationCode !== undefined
              ? { locationCode: dto.locationCode?.trim() || null }
              : {}),
          },
          select: { sku: true },
        });
        materialSku = current.sku;
        await this.syncMaterialLines(tx, materialId, {
          name,
          sku: materialSku,
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
          sku: materialSku,
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
      select: {
        id: true,
        materialId: true,
        qty: true,
        unitPrice: true,
        sourceOutboundId: true,
      },
    });
    if (!inbound) throw new NotFoundException('Không tìm thấy dòng nhập kho');
    if (inbound.sourceOutboundId) {
      throw new BadRequestException(
        'Phiếu nhập chuyển kho: xóa từ phiếu xuất ở kho nguồn.',
      );
    }

    await this.prisma.runTx(async (tx) => {
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
    return this.cached(`outbounds:${code}`, STOCK_TTL_MS, () => this.loadOutbounds(code));
  }

  private async loadOutbounds(code: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true, name: true, shortName: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const rows = await this.prisma.stockOutbound.findMany({
      where: { warehouseId: warehouse.id, applyToStock: true, qty: { gt: 0 } },
      orderBy: [{ issuedAt: 'asc' }, { sortOrder: 'asc' }],
      select: outboundListSelect,
    });

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
      items: rows.map((row) => this.toOutboundRow(row)),
    };
  }

  async createOutbound(code: string, dto: CreateOutboundDto, actor: AuthUserPayload) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true, shortName: true },
    });
    if (!warehouse) throw new NotFoundException('Không tìm thấy kho');

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên hàng không được trống');

    const qty = new Prisma.Decimal(dto.qty);
    const applyToStock = dto.applyToStock !== false;
    const dest = await this.resolveDestWarehouse(warehouse.code, dto.destWarehouseCode);

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
        'Chọn NVL đã có ở Tồn. Không tạo tên hàng mới từ Xuất.',
      );
    }

    const receiver = await this.resolveReceiver(dto.receivedByUserId, true);
    if (!receiver) throw new BadRequestException('Chọn người nhận');

    const created = await this.prisma.runTx(async (tx) => {
      const material = existing;
      await this.assertEnoughStock(tx, warehouse.id, material.id, qty);
      const lotUnit = await this.resolveMoveUnit(tx, material.id, unit);
      if (!lotUnit) {
        throw new BadRequestException('Thiếu đơn vị tính để ghi phiếu xuất');
      }
      const row = await this.applyFifoOutbound(tx, {
        warehouseId: warehouse.id,
        material: { id: material.id, name, sku: material.sku },
        unit: lotUnit,
        unitName,
        issuedAt,
        qty,
        note: dto.note?.trim() || null,
        issuedBy: actorDisplayName(actor),
        receivedBy: receiver.receivedBy,
        receivedByUserId: receiver.receivedByUserId,
        applyToStock,
      });
      if (!dest) return row;
      await this.applyTransferInbound(tx, {
        source: warehouse,
        dest,
        outboundId: row.id,
        material: { name, sku: material.sku },
        unit: lotUnit,
        unitName,
        receivedAt: issuedAt,
        qty,
        unitPrice: row.inboundUnitPrice,
        amount: row.amount,
        enteredBy: actorDisplayName(actor),
        note: dto.note?.trim() || null,
      });
      return {
        ...row,
        destWarehouse: { code: dest.code, shortName: dest.shortName },
      };
    });

    this.bustWarehouseCaches(code, dest?.code);
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
        destInboundId: true,
        destWarehouse: { select: { id: true, code: true } },
      },
    });
    if (!outbound) throw new NotFoundException('Không tìm thấy dòng xuất kho');

    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên hàng không được trống');

    const qty = new Prisma.Decimal(dto.qty);

    const unit = dto.unitId
      ? await this.prisma.unit.findUnique({
          where: { id: dto.unitId },
          select: { id: true, name: true },
        })
      : null;
    if (dto.unitId && !unit) throw new NotFoundException('Không tìm thấy đơn vị');

    const issuedAt = new Date(`${dto.issuedAt.slice(0, 10)}T00:00:00.000Z`);
    const unitName = dto.unitName?.trim() || unit?.name || 'viên';
    const receiver = await this.resolveReceiver(dto.receivedByUserId, false);

    const updated = await this.prisma.runTx(async (tx) => {
      let materialId = outbound.materialId;
      let materialSku: string | null = null;
      if (!materialId) {
        const ensured = await this.ensureMaterialInTx(tx, warehouse, name, unit);
        materialId = ensured.id;
        materialSku = ensured.sku;
      } else {
        const current = await tx.material.update({
          where: { id: materialId },
          data: {
            name,
            ...(unit?.id ? { unitId: unit.id } : {}),
          },
          select: { sku: true },
        });
        materialSku = current.sku;
        await this.syncMaterialLines(tx, materialId, {
          name,
          sku: materialSku,
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
          sku: materialSku,
          unitId: unit?.id ?? null,
          unitName,
          qty,
          stockUnitPrice: 0,
          inboundUnitPrice: quote.unitPrice,
          amount: quote.amount,
          note: dto.note?.trim() || null,
          ...(receiver
            ? {
                receivedBy: receiver.receivedBy,
                receivedByUserId: receiver.receivedByUserId,
              }
            : {}),
        },
        include: {
          unit: { select: { id: true, name: true } },
          material: { select: { id: true, sku: true } },
          destWarehouse: { select: { code: true, shortName: true } },
        },
      });

      await this.recomputeStockBalance(tx, warehouse.id, materialId);

      if (outbound.destInboundId && outbound.destWarehouse) {
        const destIn = await tx.stockInbound.findUnique({
          where: { id: outbound.destInboundId },
          select: { id: true, materialId: true },
        });
        if (destIn) {
          await tx.stockInbound.update({
            where: { id: destIn.id },
            data: {
              receivedAt: issuedAt,
              name,
              sku: materialSku,
              unitId: unit?.id ?? undefined,
              unitName,
              qty,
              unitPrice: quote.unitPrice,
              amount: quote.amount,
              note: dto.note?.trim() || null,
            },
          });
          if (destIn.materialId) {
            await this.recomputeStockBalance(tx, outbound.destWarehouse.id, destIn.materialId);
          }
        }
      }

      return row;
    });

    this.bustWarehouseCaches(code, outbound.destWarehouse?.code);
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
      select: {
        id: true,
        materialId: true,
        destInboundId: true,
        destWarehouse: { select: { id: true, code: true } },
      },
    });
    if (!outbound) throw new NotFoundException('Không tìm thấy dòng xuất kho');

    await this.prisma.runTx(async (tx) => {
      if (outbound.destInboundId && outbound.destWarehouse) {
        const destIn = await tx.stockInbound.findUnique({
          where: { id: outbound.destInboundId },
          select: { id: true, materialId: true },
        });
        if (destIn) {
          await tx.stockInbound.delete({ where: { id: destIn.id } });
          if (destIn.materialId) {
            await this.recomputeStockBalance(tx, outbound.destWarehouse.id, destIn.materialId);
          }
        }
      }
      await tx.stockOutbound.delete({ where: { id: outbound.id } });
      if (outbound.materialId) {
        await this.recomputeStockBalance(tx, warehouse.id, outbound.materialId);
      }
    });

    this.bustWarehouseCaches(code, outbound.destWarehouse?.code);
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
    const balance = await tx.stockBalance.findUnique({
      where: { materialId },
      select: { openingQty: true },
    });
    const inbound = await tx.stockInbound.aggregate({
      where: { warehouseId, materialId },
      _sum: { qty: true },
    });
    const outbound = await tx.stockOutbound.aggregate({
      where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
      _sum: { qty: true },
    });
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
    unit: { id: string; name: string } | null,
    otherClassId?: string | null,
  ) {
    const fallbackUnit =
      unit ??
      (await tx.unit.findUnique({
        where: { code: 'vien' },
        select: { id: true, name: true },
      }));
    if (!fallbackUnit) {
      throw new BadRequestException('Thiếu đơn vị tính để tạo NVL trên Tồn');
    }
    const lastMat = await tx.material.aggregate({
      where: { warehouseId: warehouse.id, isActive: true },
      _max: { sortOrder: true },
    });
    const sku = await allocateMaterialSku(tx);
    const material = await tx.material.create({
      data: {
        warehouseId: warehouse.id,
        sku,
        name,
        unitId: fallbackUnit.id,
        classification: classificationOf(warehouse.code),
        metalKind: otherClassId ? null : defaultMetalKind(warehouse.code),
        otherClassId: otherClassId || null,
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
    enteredBy: string | null;
    supplierSku: string | null;
    supplierId: string | null;
    supplierName: string | null;
    materialId: string | null;
    sourceOutboundId?: string | null;
    sourceWarehouse?: { code: string; shortName: string } | null;
    unit?: { id: string; name: string } | null;
    supplier?: { id: string; name: string } | null;
    material?: { id: string; sku: string | null } | null;
  }) {
    return {
      id: row.id,
      stt: row.sortOrder,
      receivedAt: row.receivedAt.toISOString().slice(0, 10),
      name: row.name,
      sku: row.sku ?? row.material?.sku ?? null,
      unit: row.unit?.name ?? row.unitName,
      unitId: row.unitId,
      qty: decStr(row.qty),
      stockUnitPrice: decStr(row.stockUnitPrice),
      unitPrice: decStr(row.unitPrice),
      amount: decStr(row.amount),
      note: row.note,
      enteredBy: row.enteredBy,
      supplierSku: row.supplierSku,
      supplierId: row.supplierId,
      supplierName: row.supplierName ?? row.supplier?.name ?? null,
      materialId: row.materialId,
      sourceWarehouseCode: row.sourceWarehouse?.code ?? null,
      sourceWarehouseName: row.sourceWarehouse?.shortName ?? null,
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
    receivedByUserId: string | null;
    materialId: string | null;
    destInboundId?: string | null;
    destWarehouse?: { code: string; shortName: string } | null;
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
      receivedByUserId: row.receivedByUserId,
      materialId: row.materialId,
      destWarehouseCode: row.destWarehouse?.code ?? null,
      destWarehouseName: row.destWarehouse?.shortName ?? null,
      priceBreakdown: (takes ?? []).map((take) => ({
        qty: decStr(take.qty),
        unitPrice: decStr(take.unitPrice),
        source: take.kind,
      })),
    };
  }

  private async assertAssignableLocation(
    warehouseId: string,
    locationCode: string | null | undefined,
    exceptMaterialId?: string | null,
  ) {
    const code = locationCode?.trim() || '';
    if (!code) return;
    const slot = await this.prisma.warehouseLocation.findFirst({
      where: { warehouseId, code, isActive: true },
      select: { id: true },
    });
    if (!slot) {
      const configured = await this.prisma.warehouseLocation.findFirst({
        where: { warehouseId, isActive: true },
        select: { id: true },
      });
      if (configured) {
        throw new BadRequestException('Chọn vị trí đã cấu hình (vd A1C12)');
      }
    }
    const taken = await this.prisma.material.findFirst({
      where: {
        warehouseId,
        isActive: true,
        locationCode: code,
        ...(exceptMaterialId ? { NOT: { id: exceptMaterialId } } : {}),
      },
      select: { name: true },
    });
    if (taken) {
      throw new BadRequestException(`Vị trí ${code} đang dùng cho ${taken.name}`);
    }
  }

  private async resolveReceiver(
    userId: string | null | undefined,
    required: boolean,
  ): Promise<{ receivedByUserId: string; receivedBy: string } | null> {
    if (!userId) {
      if (required) throw new BadRequestException('Chọn người nhận');
      return null;
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, fullName: true, username: true },
    });
    if (!user) throw new BadRequestException('Không tìm thấy người nhận');
    return {
      receivedByUserId: user.id,
      receivedBy: actorDisplayName(user),
    };
  }

  private assertLookups(
    shapeId?: string | null,
    colorId?: string | null,
    materialTypeId?: string | null,
    bodyMetalId?: string | null,
    productKindId?: string | null,
    btpCategoryId?: string | null,
  ) {
    return Promise.all([
      this.assertLookup('shape', shapeId),
      this.assertLookup('color', colorId),
      this.assertLookup('materialType', materialTypeId),
      this.assertCatalogChild('chat-lieu', bodyMetalId),
      this.assertCatalogChild('phan-loai-san-pham', productKindId),
      this.assertCatalogChild('danh-muc-btp', btpCategoryId),
    ]);
  }

  private async assertCatalogChild(parentCode: string, id?: string | null) {
    if (!id) return;
    const found = await this.prisma.otherClass.findFirst({
      where: { id, parent: { code: parentCode } },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Danh mục không hợp lệ');
  }

  private async listCatalogChildrenByParent(parentCode: string) {
    return this.prisma.otherClass.findMany({
      where: { parent: { code: parentCode } },
      select: lookupSelect,
      orderBy: { sortOrder: 'asc' },
    });
  }

  private async listCatalogChildren(
    code: string,
    name: string,
    sortOrder: number,
    kind: OtherClassKind = OtherClassKind.CATALOG,
  ) {
    const parent = await this.ensureCatalogParent(code, name, sortOrder, kind);
    await this.prisma.otherClass.updateMany({
      where: { parentId: parent.id, NOT: { kind } },
      data: { kind },
    });
    await this.ensureDefaultChildren(parent.id, code, kind);
    return this.prisma.otherClass.findMany({
      where: { parentId: parent.id },
      select: lookupSelect,
      orderBy: { sortOrder: 'asc' },
    });
  }

  private async ensureDefaultChildren(
    parentId: string,
    parentCode: string,
    kind: OtherClassKind,
  ) {
    const defaults: Record<string, Array<{ code: string; name: string; sortOrder: number }>> = {
      'chat-lieu': [
        { code: 'chat-lieu-bac', name: 'Bạc', sortOrder: 1 },
        { code: 'chat-lieu-vang', name: 'Vàng', sortOrder: 2 },
        { code: 'chat-lieu-hoi-pha', name: 'Hội pha', sortOrder: 3 },
        { code: 'chat-lieu-dong', name: 'Đồng', sortOrder: 4 },
      ],
      'danh-muc-btp': [
        { code: 'btp-da', name: 'Đá', sortOrder: 1 },
        { code: 'btp-si-bong', name: 'Si bóng', sortOrder: 2 },
      ],
      'phan-loai-san-pham': [
        { code: 'sp-nhan', name: 'Nhẫn', sortOrder: 1 },
        { code: 'sp-day-chuyen', name: 'Dây chuyền', sortOrder: 2 },
        { code: 'sp-lac-tay', name: 'Lắc tay', sortOrder: 3 },
        { code: 'sp-lac-chan', name: 'Lắc chân', sortOrder: 4 },
        { code: 'sp-bong-tai', name: 'Bông tai', sortOrder: 5 },
        { code: 'sp-mat-day', name: 'Mặt dây', sortOrder: 6 },
        { code: 'sp-charm', name: 'Charm', sortOrder: 7 },
        { code: 'sp-bo', name: 'Bộ trang sức', sortOrder: 8 },
        { code: 'sp-khac', name: 'Khác', sortOrder: 9 },
      ],
    };
    const rows = defaults[parentCode];
    if (!rows) return;
    let changed = false;
    for (const row of rows) {
      const clash = await this.prisma.otherClass.findUnique({
        where: { code: row.code },
        select: { id: true, parentId: true },
      });
      if (clash) {
        if (clash.parentId !== parentId) {
          await this.prisma.otherClass.update({
            where: { id: clash.id },
            data: { parentId, kind, name: row.name, sortOrder: row.sortOrder },
          });
          changed = true;
        }
        continue;
      }
      await this.prisma.otherClass.create({
        data: { ...row, kind, parentId },
      });
      changed = true;
    }
    if (changed) this.bustLookups();
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
    const nxt =
      inbound || outbound
        ? nxtFigures(
            b?.openingQty ?? new Prisma.Decimal(0),
            b?.openingAmount ?? new Prisma.Decimal(0),
            inbound,
            outbound,
          )
        : nxtFromBalance(b);
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
      materialType: m.materialType?.name ?? m.otherClass?.name ?? null,
      otherClassId: m.otherClassId,
      otherClass: m.otherClass?.name ?? null,
      otherClassParentId: m.otherClass?.parent?.id ?? (m.otherClass && !m.otherClass.parentId ? m.otherClass.id : null),
      otherClassParent: m.otherClass?.parent?.name ?? (m.otherClass && !m.otherClass.parentId ? m.otherClass.name : null),
      bodyMetalId: m.bodyMetalId,
      bodyMetal: m.bodyMetal?.name ?? null,
      productKindId: m.productKindId,
      productKind: m.productKind?.name ?? null,
      classificationCode: m.classification,
      classification: CLASS_LABEL[m.classification] ?? m.classification,
      metalKind: m.metalKind,
      metalKindLabel: m.metalKind
        ? (METAL_KIND_LABEL[m.metalKind] ?? m.metalKind)
        : m.otherClass?.parent?.code === 'phan-loai-khac'
          ? 'Phân loại khác'
          : m.otherClass?.parent?.name ??
            (m.otherClass && !m.otherClass.parentId ? m.otherClass.name : null),
      availability: av.code,
      availabilityLabel: av.label,
    };
  }

  bustLookups() {
    this.cache.delete('lookups');
    this.cache.delete('lookups:users');
  }

  async ensureBtpCatalogs() {
    await Promise.all([
      this.listCatalogChildren('chat-lieu', 'Chất liệu', 9, OtherClassKind.OTHER),
      this.listCatalogChildren('danh-muc-btp', 'Danh mục BTP', 10, OtherClassKind.OTHER),
      this.listCatalogChildren('phan-loai-san-pham', 'Phân loại sản phẩm', 11, OtherClassKind.OTHER),
    ]);
  }

  private async assertConsumableClass(id?: string | null) {
    if (!id) return;
    const found = await this.prisma.otherClass.findFirst({
      where: {
        id,
        parentId: null,
        code: { in: ['ccdc', 'nvl-phu', 'nvl-chinh'] },
      },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Danh mục không hợp lệ');
  }

  private async listConsumableCategories() {
    const groups = [
      { code: 'ccdc', name: 'CCDC', sortOrder: 6 },
      { code: 'nvl-phu', name: 'NVL phụ', sortOrder: 7 },
      { code: 'nvl-chinh', name: 'NVL chính', sortOrder: 8 },
    ];
    const items: Array<{ id: string; code: string; name: string }> = [];
    for (const group of groups) {
      const parent = await this.ensureCatalogParent(group.code, group.name, group.sortOrder);
      items.push({ id: parent.id, code: group.code, name: group.name });
    }
    return items;
  }

  private async resolveOtherClassId(raw?: string | null) {
    const name = raw?.trim();
    if (!name) return null;
    const parent = await this.ensureOtherClassParent();
    const existing = await this.prisma.otherClass.findFirst({
      where: {
        parentId: parent.id,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) return existing.id;
    const last = await this.prisma.otherClass.aggregate({
      where: { parentId: parent.id },
      _max: { sortOrder: true },
    });
    const base = slugFromName(name);
    let code = base;
    let n = 2;
    while (await this.prisma.otherClass.findUnique({ where: { code }, select: { id: true } })) {
      code = `${base}-${n}`;
      n += 1;
    }
    const created = await this.prisma.otherClass.create({
      data: {
        name,
        code,
        parentId: parent.id,
        sortOrder: (last._max.sortOrder ?? 0) + 1,
      },
      select: { id: true },
    });
    this.bustLookups();
    return created.id;
  }

  private async ensureOtherClassParent() {
    return this.ensureCatalogParent('phan-loai-khac', 'Phân loại khác', 8);
  }

  private async ensureCatalogParent(
    code: string,
    name: string,
    sortOrder: number,
    kind: OtherClassKind = OtherClassKind.CATALOG,
  ) {
    const existing = await this.prisma.otherClass.findUnique({
      where: { code },
      select: { id: true, kind: true },
    });
    if (existing) {
      if (existing.kind !== kind) {
        await this.prisma.otherClass.update({
          where: { id: existing.id },
          data: { kind },
        });
      }
      return existing;
    }
    return this.prisma.otherClass.create({
      data: { code, name, sortOrder, kind },
      select: { id: true },
    });
  }

  private bustWarehouseCaches(...codes: Array<string | null | undefined>) {
    for (const code of codes) {
      if (!code) continue;
      this.cache.delete(`stock:${code}`);
      this.cache.delete(`inbounds:${code}`);
      this.cache.delete(`outbounds:${code}`);
    }
  }

  /** Tồn kho SL/TT = đầu kỳ + nhập − xuất. One SQL so the tx does not multiplex. */
  private async recomputeStockBalance(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string | null,
  ) {
    if (!materialId) return;
    await tx.$executeRaw`
      INSERT INTO stock_balances (
        id, warehouse_id, material_id,
        opening_qty, opening_amount, stock_unit_price,
        in_qty, in_amount, out_qty, out_amount, qty, amount, updated_at
      )
      SELECT
        gen_random_uuid(),
        ${warehouseId}::uuid,
        ${materialId}::uuid,
        COALESCE(b.opening_qty, 0),
        COALESCE(b.opening_amount, 0),
        COALESCE(b.stock_unit_price, 0),
        COALESCE(i.qty, 0),
        COALESCE(i.amount, 0),
        COALESCE(o.qty, 0),
        COALESCE(o.amount, 0),
        COALESCE(b.opening_qty, 0) + COALESCE(i.qty, 0) - COALESCE(o.qty, 0),
        COALESCE(b.opening_amount, 0) + COALESCE(i.amount, 0) - COALESCE(o.amount, 0),
        NOW()
      FROM (SELECT 1) AS dummy
      LEFT JOIN stock_balances b ON b.material_id = ${materialId}::uuid
      LEFT JOIN (
        SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(amount), 0) AS amount
        FROM stock_inbounds
        WHERE warehouse_id = ${warehouseId}::uuid
          AND material_id = ${materialId}::uuid
          AND apply_to_stock = true
          AND qty > 0
      ) i ON true
      LEFT JOIN (
        SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(amount), 0) AS amount
        FROM stock_outbounds
        WHERE warehouse_id = ${warehouseId}::uuid
          AND material_id = ${materialId}::uuid
          AND apply_to_stock = true
          AND qty > 0
      ) o ON true
      ON CONFLICT (material_id) DO UPDATE SET
        in_qty = EXCLUDED.in_qty,
        in_amount = EXCLUDED.in_amount,
        out_qty = EXCLUDED.out_qty,
        out_amount = EXCLUDED.out_amount,
        qty = EXCLUDED.qty,
        amount = EXCLUDED.amount,
        updated_at = NOW()
    `;
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
    await tx.stockInbound.updateMany({ where: { materialId }, data });
    await tx.stockOutbound.updateMany({ where: { materialId }, data });
  }

  private async availableOnHand(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string,
    exceptOutboundId?: string,
  ) {
    const zero = new Prisma.Decimal(0);
    const locked = await tx.$queryRaw<Array<{ opening_qty: Prisma.Decimal }>>`
      SELECT opening_qty FROM stock_balances WHERE material_id = ${materialId}::uuid FOR UPDATE
    `;
    const inbound = await tx.stockInbound.aggregate({
      where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
      _sum: { qty: true },
    });
    const outbound = await tx.stockOutbound.aggregate({
      where: {
        warehouseId,
        materialId,
        applyToStock: true,
        qty: { gt: 0 },
        ...(exceptOutboundId ? { NOT: { id: exceptOutboundId } } : {}),
      },
      _sum: { qty: true },
    });
    return (locked[0]?.opening_qty ?? zero)
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

  private async resolveDestWarehouse(sourceCode: string, destCode?: string | null) {
    const code = destCode?.trim();
    if (!code) return null;
    if (code === sourceCode) {
      throw new BadRequestException('Kho nhận phải khác kho đang xuất');
    }
    const dest = await this.prisma.warehouse.findUnique({
      where: { code },
      select: { id: true, code: true, shortName: true, isActive: true },
    });
    if (!dest?.isActive) throw new NotFoundException('Không tìm thấy kho nhận');
    return dest;
  }

  private async applyTransferInbound(
    tx: Prisma.TransactionClient,
    params: {
      source: { id: string; code: string; shortName?: string };
      dest: { id: string; code: string };
      outboundId: string;
      material: { name: string; sku: string | null };
      unit: { id: string; name: string };
      unitName: string;
      receivedAt: Date;
      qty: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      amount: Prisma.Decimal;
      enteredBy: string | null;
      note: string | null;
    },
  ) {
    const destMaterial =
      (params.material.sku
        ? await tx.material.findFirst({
            where: {
              warehouseId: params.dest.id,
              sku: params.material.sku,
              isActive: true,
            },
            select: { id: true, sku: true },
          })
        : null) ??
      (await tx.material.findFirst({
        where: {
          warehouseId: params.dest.id,
          name: params.material.name,
          isActive: true,
        },
        select: { id: true, sku: true },
      })) ??
      (await this.ensureMaterialInTx(tx, params.dest, params.material.name, params.unit));
    const last = await tx.stockInbound.aggregate({
      where: { warehouseId: params.dest.id },
      _max: { sortOrder: true },
    });
    const transferNote = [
      `Chuyển từ ${params.source.shortName ?? params.source.code}`,
      params.note,
    ]
      .filter(Boolean)
      .join(' — ');
    const inbound = await tx.stockInbound.create({
      data: {
        warehouseId: params.dest.id,
        materialId: destMaterial.id,
        sortOrder: (last._max.sortOrder ?? 0) + 1,
        receivedAt: params.receivedAt,
        name: params.material.name,
        sku: destMaterial.sku ?? params.material.sku,
        unitId: params.unit.id,
        unitName: params.unitName,
        qty: params.qty,
        stockUnitPrice: 0,
        unitPrice: params.unitPrice,
        amount: params.amount,
        note: transferNote || null,
        enteredBy: params.enteredBy,
        applyToStock: true,
        sourceWarehouseId: params.source.id,
        sourceOutboundId: params.outboundId,
      },
    });
    await tx.stockOutbound.update({
      where: { id: params.outboundId },
      data: { destWarehouseId: params.dest.id, destInboundId: inbound.id },
    });
    await this.recomputeStockBalance(tx, params.dest.id, destMaterial.id);
    return inbound;
  }

  private async importBtpWaitingToStock(warehouse: { id: string; code: string }) {
    const waiting = await this.prisma.btpWaitingItem.findMany({
      where: { warehouseId: warehouse.id },
      orderBy: [{ sortOrder: 'asc' }, { receivedAt: 'asc' }],
      select: {
        id: true,
        name: true,
        qty: true,
        weight: true,
        note: true,
        enteredBy: true,
        receivedAt: true,
        craftsmanName: true,
        unitId: true,
        unitName: true,
      },
    });
    if (!waiting.length) return;

    for (const row of waiting) {
      await this.prisma.runTx(async (tx) => {
        const stillThere = await tx.btpWaitingItem.findUnique({
          where: { id: row.id },
          select: { id: true },
        });
        if (!stillThere) return;

        const unit =
          (row.unitId
            ? await tx.unit.findUnique({
                where: { id: row.unitId },
                select: { id: true, name: true },
              })
            : null) ??
          (row.unitName
            ? await tx.unit.findFirst({
                where: { name: row.unitName },
                select: { id: true, name: true },
              })
            : null);
        const material =
          (await tx.material.findFirst({
            where: { warehouseId: warehouse.id, name: row.name, isActive: true },
            select: { id: true, sku: true },
          })) ?? (await this.ensureMaterialInTx(tx, warehouse, row.name, unit));
        const last = await tx.stockInbound.aggregate({
          where: { warehouseId: warehouse.id },
          _max: { sortOrder: true },
        });
        const extras = [
          row.craftsmanName ? `Thợ: ${row.craftsmanName}` : null,
          row.weight && !row.weight.isZero() ? `TL: ${decStr(row.weight)}` : null,
        ].filter(Boolean);
        const note = [...extras, row.note].filter(Boolean).join(' — ') || null;
        await tx.stockInbound.create({
          data: {
            warehouseId: warehouse.id,
            materialId: material.id,
            sortOrder: (last._max.sortOrder ?? 0) + 1,
            receivedAt: row.receivedAt,
            name: row.name,
            unitId: unit?.id ?? null,
            unitName: unit?.name ?? row.unitName,
            qty: row.qty,
            applyToStock: true,
            note,
            enteredBy: row.enteredBy,
          },
        });
        await this.recomputeStockBalance(tx, warehouse.id, material.id);
        await tx.btpWaitingItem.delete({ where: { id: row.id } });
      });
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
      receivedByUserId: string | null;
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
        receivedByUserId: params.receivedByUserId,
        applyToStock: params.applyToStock,
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

  private async fullLayersByMaterial(warehouseId: string, materialIds?: string[]) {
    if (materialIds && materialIds.length === 0) return new Map<string, PriceLayer[]>();
    const materialFilter = materialIds ? { in: materialIds } : { not: null };
    const [balances, inbounds] = await Promise.all([
      this.prisma.stockBalance.findMany({
        where: {
          warehouseId,
          ...(materialIds ? { materialId: { in: materialIds } } : {}),
        },
        select: {
          materialId: true,
          openingQty: true,
          openingAmount: true,
          stockUnitPrice: true,
        },
      }),
      this.prisma.stockInbound.findMany({
        where: {
          warehouseId,
          materialId: materialFilter,
          applyToStock: true,
          qty: { gt: 0 },
        },
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

  private async listPriceLayers(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    materialId: string,
    exceptOutboundId?: string,
  ) {
    const balance = await tx.stockBalance.findUnique({
      where: { materialId },
      select: { openingQty: true, openingAmount: true, stockUnitPrice: true },
    });
    const inbounds = await tx.stockInbound.findMany({
      where: { warehouseId, materialId, applyToStock: true, qty: { gt: 0 } },
      orderBy: [{ receivedAt: 'asc' }, { sortOrder: 'asc' }],
      select: { qty: true, unitPrice: true },
    });
    const outbound = await tx.stockOutbound.aggregate({
      where: {
        warehouseId,
        materialId,
        applyToStock: true,
        qty: { gt: 0 },
        ...(exceptOutboundId ? { NOT: { id: exceptOutboundId } } : {}),
      },
      _sum: { qty: true },
    });
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
  if (warehouseCode === 'btp-cho-vao-da' || warehouseCode === 'ban-thanh-pham') {
    return MaterialClass.SEMI_FINISHED;
  }
  return MaterialClass.RAW_MATERIAL;
}

function defaultMetalKind(warehouseCode: string): MetalKind | null {
  if (warehouseCode === 'nvl-tieu-hao') return null;
  return MetalKind.SILVER;
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

function nxtFromBalance(balance?: {
  inQty?: Prisma.Decimal | null;
  inAmount?: Prisma.Decimal | null;
  outQty?: Prisma.Decimal | null;
  outAmount?: Prisma.Decimal | null;
  qty?: Prisma.Decimal | null;
  amount?: Prisma.Decimal | null;
} | null) {
  const zero = new Prisma.Decimal(0);
  return {
    inQty: balance?.inQty ?? zero,
    inAmount: balance?.inAmount ?? zero,
    outQty: balance?.outQty ?? zero,
    outAmount: balance?.outAmount ?? zero,
    qty: balance?.qty ?? zero,
    amount: balance?.amount ?? zero,
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

function actorDisplayName(actor: { fullName: string; username: string }) {
  return actor.fullName.trim() || actor.username;
}
