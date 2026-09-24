import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProductionImageKind,
  ProductionRequestType,
  ProductionSource,
  ProductionStatus,
} from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { recordEditLog } from '../edit-logs/edit-log';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionCostingService } from '../production-orders/production-costing.service';
import { randomUUID } from 'node:crypto';
import { orderCode } from '../production-orders/production-orders.service';
import { availabilityOf, decStr, METAL_KIND_LABEL } from '../util/money';
import {
  ListShipmentsQuery,
  ReceiveReceiptDto,
  ShipmentLineDto,
  UpsertReceiptDto,
  UpsertShipmentDto,
} from './dto/shipment.dto';

const DEFAULT_PAYMENT_METHODS = ['Tiền mặt', 'Chuyển khoản', 'VCB'];
const OPENING_COST_NAME = 'Giá vốn đầu kỳ';
const STOCK_TRACKING_PREFIX = 'KHO-';
const NVL_WAREHOUSE_CODE = 'nvl-chinh';

const nvlSelect = {
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
  images: {
    select: { url: true },
    orderBy: { sortOrder: 'asc' as const },
    take: 1,
  },
} satisfies Prisma.MaterialSelect;

type NvlSnapshot = Prisma.MaterialGetPayload<{ select: typeof nvlSelect }>;

function mapNvl(row: NvlSnapshot) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit.name,
    qty: decStr(row.balance?.qty),
    locationCode: row.locationCode ?? null,
    shape: row.shape?.name ?? null,
    color: row.color?.name ?? null,
    materialType: row.materialType?.name ?? null,
    bodyMetal: row.bodyMetal?.name ?? null,
    metalKind: row.metalKind
      ? (METAL_KIND_LABEL[row.metalKind] ?? row.metalKind)
      : null,
    sizeLabel: row.sizeLabel,
    note: row.note,
    imageUrl: row.images[0]?.url ?? null,
  };
}

const CREATE_RETRIES = 3;

const shipmentInclude = {
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: {
      order: {
        select: {
          code: true,
          description: true,
          qty: true,
          sizeLabel: true,
          size: true,
          mainMaterial: true,
          images: {
            where: { kind: ProductionImageKind.PRODUCT },
            select: { url: true },
            orderBy: { sortOrder: 'asc' },
            take: 1,
          },
        },
      },
    },
  },
} satisfies Prisma.ShipmentInclude;

type ShipmentDetail = Prisma.ShipmentGetPayload<{
  include: typeof shipmentInclude;
}>;

@Injectable()
export class FinishedGoodsService {
  // Không cache sổ tồn / phiếu nhập ở đây: KCS, lên đơn NVL từ thành phẩm và mọi thay đổi
  // giá vốn (tiền công khâu, chi phí khác, phiếu xuất gắn đơn) đều ghi từ service khác,
  // cache sẽ trả số cũ sau các thao tác đó.
  constructor(
    private readonly prisma: PrismaService,
    private readonly costing: ProductionCostingService,
  ) {}

  /**
   * Sổ tồn thành phẩm:
   * Tồn đầu kỳ = nhập trên tab Tồn; Nhập = phiếu tab Nhập / KCS; Xuất = phiếu khách.
   * Lên đơn trừ cột Tồn (đầu kỳ + nhập − xuất).
   */
  async stock(search?: string) {
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
                  {
                    bomLines: {
                      some: {
                        material: {
                          OR: [
                            { sku: { contains: keyword, mode: 'insensitive' } },
                            {
                              name: { contains: keyword, mode: 'insensitive' },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            }
          : {}),
      },
      orderBy: { receivedAt: 'desc' },
      include: {
        order: {
          select: {
            id: true,
            code: true,
            description: true,
            requestType: true,
            qtyUnit: true,
            sizeLabel: true,
            mainMaterial: true,
            platingColor: true,
            trackingCode: true,
            images: {
              where: { kind: ProductionImageKind.PRODUCT },
              select: { url: true },
              orderBy: { sortOrder: 'asc' },
              take: 1,
            },
            shipmentLines: { select: { qty: true } },
            bomLines: {
              orderBy: { sortOrder: 'asc' },
              select: { material: { select: nvlSelect } },
            },
          },
        },
      },
    });

    const zero = new Prisma.Decimal(0);
    const totals = {
      openingQty: zero,
      openingAmount: zero,
      inQty: zero,
      inAmount: zero,
      outQty: zero,
      outAmount: zero,
      qty: zero,
      amount: zero,
    };
    const costs = await this.costing.costingMany(
      receipts.map((receipt) => receipt.order.id),
    );
    const items = [];
    for (const receipt of receipts) {
      const shippedQty = receipt.order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      const remainingQty = receipt.stockedQty - shippedQty;
      const cost = costs.get(receipt.order.id);
      if (!cost) continue;
      const isOpening = (receipt.order.trackingCode ?? '').startsWith(
        STOCK_TRACKING_PREFIX,
      );
      const openingQty = isOpening
        ? new Prisma.Decimal(receipt.stockedQty)
        : zero;
      const inQty = isOpening ? zero : new Prisma.Decimal(receipt.stockedQty);
      const outQty = new Prisma.Decimal(shippedQty);
      const qty = new Prisma.Decimal(remainingQty);
      const openingAmount = cost.unitCostDecimal
        .mul(openingQty)
        .toDecimalPlaces(2);
      const inAmount = cost.unitCostDecimal.mul(inQty).toDecimalPlaces(2);
      const outAmount = cost.unitCostDecimal.mul(outQty).toDecimalPlaces(2);
      const amount = cost.unitCostDecimal.mul(qty).toDecimalPlaces(2);
      const availability = availabilityOf(qty, 1);
      totals.openingQty = totals.openingQty.add(openingQty);
      totals.openingAmount = totals.openingAmount.add(openingAmount);
      totals.inQty = totals.inQty.add(inQty);
      totals.inAmount = totals.inAmount.add(inAmount);
      totals.outQty = totals.outQty.add(outQty);
      totals.outAmount = totals.outAmount.add(outAmount);
      totals.qty = totals.qty.add(qty);
      totals.amount = totals.amount.add(amount);
      items.push({
        id: receipt.id,
        orderCode: receipt.order.code,
        description: receipt.order.description,
        requestType: receipt.order.requestType,
        qtyUnit: receipt.order.qtyUnit,
        sizeLabel: receipt.order.sizeLabel,
        mainMaterial: receipt.order.mainMaterial,
        platingColor: receipt.order.platingColor,
        imageUrl: receipt.order.images[0]?.url ?? null,
        bomLines: receipt.order.bomLines.map((line) => mapNvl(line.material)),
        isOpening,
        openingQty: decStr(openingQty),
        openingAmount: decStr(openingAmount),
        inQty: decStr(inQty),
        inAmount: decStr(inAmount),
        outQty: decStr(outQty),
        outAmount: decStr(outAmount),
        qty: decStr(qty),
        amount: decStr(amount),
        receivedQty: receipt.stockedQty,
        shippedQty,
        remainingQty,
        receivedAt: receipt.receivedAt.toISOString(),
        receivedByName: receipt.receivedByName,
        unitCost: cost.unitCost,
        stockValue: decStr(amount),
        costWarnings: cost.warnings.length,
        availability: availability.code,
        availabilityLabel: availability.label,
      });
    }
    return {
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

  /** Phiếu tab Nhập / KCS — không gồm tồn đầu kỳ tạo trên Tồn. */
  async receipts(search?: string) {
    const keyword = search?.trim();
    const receipts = await this.prisma.finishedGoodsReceipt.findMany({
      where: {
        order: {
          AND: [
            {
              OR: [
                { trackingCode: null },
                {
                  NOT: { trackingCode: { startsWith: STOCK_TRACKING_PREFIX } },
                },
              ],
            },
            ...(keyword
              ? [
                  {
                    OR: [
                      {
                        code: {
                          contains: keyword,
                          mode: 'insensitive' as const,
                        },
                      },
                      {
                        description: {
                          contains: keyword,
                          mode: 'insensitive' as const,
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      },
      orderBy: { receivedAt: 'desc' },
      include: {
        order: {
          select: {
            id: true,
            code: true,
            description: true,
            qtyUnit: true,
            sizeLabel: true,
            mainMaterial: true,
            images: {
              where: { kind: ProductionImageKind.PRODUCT },
              select: { url: true },
              orderBy: { sortOrder: 'asc' },
              take: 1,
            },
            shipmentLines: { select: { qty: true } },
          },
        },
      },
    });
    const costs = await this.costing.costingMany(
      receipts.map((receipt) => receipt.order.id),
    );
    const items = [];
    for (const receipt of receipts) {
      const shippedQty = receipt.order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      const cost = costs.get(receipt.order.id);
      if (!cost) continue;
      const qty = new Prisma.Decimal(receipt.qty);
      const pendingQty = Math.max(0, receipt.qty - receipt.stockedQty);
      const amount = cost.unitCostDecimal.mul(qty).toDecimalPlaces(2);
      items.push({
        id: receipt.id,
        orderCode: receipt.order.code,
        description: receipt.order.description,
        qtyUnit: receipt.order.qtyUnit,
        sizeLabel: receipt.order.sizeLabel,
        mainMaterial: receipt.order.mainMaterial,
        imageUrl: receipt.order.images[0]?.url ?? null,
        qty: decStr(qty),
        stockedQty: receipt.stockedQty,
        pendingQty,
        status: pendingQty > 0 ? ('PENDING' as const) : ('RECEIVED' as const),
        unitPrice: cost.unitCost,
        amount: decStr(amount),
        shippedQty,
        remainingQty: receipt.stockedQty - shippedQty,
        receivedAt: ymd(receipt.receivedAt),
        receivedByName: receipt.receivedByName,
        note: null,
      });
    }
    return { items };
  }

  /** Ô "Tên thành phẩm" trên phiếu Nhập — chỉ hàng đã có trên Tồn. */
  async orderOptions(search?: string) {
    const keyword = search?.trim();
    const nameFilter = keyword
      ? {
          OR: [
            { code: { contains: keyword, mode: 'insensitive' as const } },
            {
              description: { contains: keyword, mode: 'insensitive' as const },
            },
            {
              trackingCode: { contains: keyword, mode: 'insensitive' as const },
            },
          ],
        }
      : undefined;

    const stock = await this.prisma.finishedGoodsReceipt.findMany({
      where: {
        stockedQty: { gt: 0 },
        ...(nameFilter ? { order: nameFilter } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: {
        order: {
          select: {
            code: true,
            description: true,
            qtyUnit: true,
            sizeLabel: true,
            mainMaterial: true,
            shipmentLines: { select: { qty: true } },
          },
        },
      },
    });

    return {
      items: stock.map((receipt) => {
        const shippedQty = receipt.order.shipmentLines.reduce(
          (sum, line) => sum + line.qty,
          0,
        );
        return {
          code: receipt.order.code,
          description: receipt.order.description,
          qty: receipt.stockedQty,
          qtyUnit: receipt.order.qtyUnit,
          sizeLabel: receipt.order.sizeLabel,
          mainMaterial: receipt.order.mainMaterial,
          inStock: true as const,
          remainingQty: receipt.stockedQty - shippedQty,
        };
      }),
    };
  }

  /** Danh sách NVL kho chính để gắn vào thành phẩm — gồm cả mã tồn 0. */
  async nvlOptions(search?: string) {
    const keyword = search?.trim();
    const rows = await this.prisma.material.findMany({
      where: {
        isActive: true,
        warehouse: { code: NVL_WAREHOUSE_CODE },
        ...(keyword
          ? {
              OR: [
                { sku: { contains: keyword, mode: 'insensitive' } },
                { name: { contains: keyword, mode: 'insensitive' } },
              ],
            }
          : null),
      },
      orderBy: [{ sortOrder: 'asc' }, { sku: 'asc' }, { name: 'asc' }],
      take: 500,
      select: nvlSelect,
    });
    return { items: rows.map(mapNvl) };
  }

  async createReceipt(dto: UpsertReceiptDto, actor: AuthUserPayload) {
    if (!dto.orderCode?.trim()) {
      return this.createStockEntry(dto, actor);
    }
    if (dto.qty < 1) {
      throw new BadRequestException('Số lượng nhập phải lớn hơn 0');
    }
    const order = await this.requireReceiptOrder(dto.orderCode);
    if (!order.receipt) {
      throw new BadRequestException(
        'Chọn thành phẩm đang có trên Tồn. Đơn sản xuất lên Tồn trước.',
      );
    }
    await this.prisma.finishedGoodsReceipt.update({
      where: { id: order.receipt.id },
      data: {
        qty: order.receipt.qty + dto.qty,
        stockedQty: order.receipt.stockedQty + dto.qty,
        receivedAt: receiptDate(dto.receivedAt),
        receivedByUserId: actor.id,
        receivedByName: actorName(actor),
      },
    });
    if (dto.sizeLabel !== undefined || dto.qtyUnit !== undefined) {
      await this.prisma.productionOrder.update({
        where: { id: order.id },
        data: {
          ...(dto.sizeLabel !== undefined
            ? { sizeLabel: dto.sizeLabel.trim() || null }
            : {}),
          ...(dto.qtyUnit !== undefined
            ? { qtyUnit: dto.qtyUnit.trim() || null }
            : {}),
        },
      });
    }
    return { success: true };
  }

  /**
   * Kho xác nhận nhận hàng: chỉ lúc này phần đang chờ mới được cộng vào tồn. Nhận đúng số
   * đếm được, thiếu thì nhận từng phần — phần còn lại vẫn nằm chờ trên phiếu.
   */
  async receiveReceipt(
    id: string,
    dto: ReceiveReceiptDto,
    actor: AuthUserPayload,
  ) {
    const receipt = await this.prisma.finishedGoodsReceipt.findUnique({
      where: { id },
      select: { id: true, qty: true, stockedQty: true },
    });
    if (!receipt) throw new NotFoundException('Không tìm thấy phiếu nhập');
    const pendingQty = receipt.qty - receipt.stockedQty;
    if (pendingQty <= 0) {
      throw new BadRequestException('Phiếu này đã vào tồn đầy đủ');
    }
    const takenQty = dto.qty ?? pendingQty;
    if (takenQty > pendingQty) {
      throw new BadRequestException(
        `Phiếu chỉ còn ${pendingQty} đang chờ vào tồn`,
      );
    }
    await this.prisma.finishedGoodsReceipt.update({
      where: { id },
      data: {
        stockedQty: receipt.stockedQty + takenQty,
        receivedAt: new Date(),
        receivedByUserId: actor.id,
        receivedByName: actorName(actor),
      },
    });
    return { success: true };
  }

  async updateReceipt(
    id: string,
    dto: UpsertReceiptDto,
    actor: AuthUserPayload,
  ) {
    const receipt = await this.prisma.finishedGoodsReceipt.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
            code: true,
            description: true,
            shipmentLines: { select: { qty: true } },
          },
        },
      },
    });
    if (!receipt) throw new NotFoundException('Không tìm thấy phiếu nhập');
    if (
      dto.orderCode &&
      receipt.order.code !== dto.orderCode.trim().toUpperCase()
    ) {
      throw new BadRequestException('Không đổi mã đơn trên phiếu nhập đã có');
    }
    const shippedQty = receipt.order.shipmentLines.reduce(
      (sum, line) => sum + line.qty,
      0,
    );
    // Sửa giảm vẫn phải được — đếm lại thấy thiếu là chuyện thường. Chỉ chặn xuống dưới số
    // đã xuất, còn phần đã vào tồn thì kéo xuống theo chứ không lấy làm sàn.
    if (dto.qty < shippedQty) {
      throw new BadRequestException(
        `Đã xuất ${shippedQty} — số lượng nhập không được nhỏ hơn số đã xuất`,
      );
    }
    const changedBy = actorName(actor);
    if (dto.description !== undefined) {
      await this.assertUniqueStockName(
        dto.description.trim(),
        receipt.order.id,
      );
    }
    await this.prisma.productionOrder.update({
      where: { id: receipt.order.id },
      data: {
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.mainMaterial !== undefined
          ? { mainMaterial: dto.mainMaterial.trim() || null }
          : {}),
        ...(dto.platingColor !== undefined
          ? { platingColor: dto.platingColor.trim() || null }
          : {}),
        ...(dto.sizeLabel !== undefined
          ? { sizeLabel: dto.sizeLabel.trim() || null }
          : {}),
        ...(dto.qtyUnit !== undefined
          ? { qtyUnit: dto.qtyUnit.trim() || null }
          : {}),
        receipt: {
          update: {
            qty: dto.qty,
            // Phiếu đã vào tồn đủ thì đi theo số mới; phiếu còn dở chỉ bị cắt khi số mới
            // thấp hơn phần đã nhận. Bất biến: stockedQty không bao giờ vượt qty.
            stockedQty:
              receipt.stockedQty === receipt.qty
                ? dto.qty
                : Math.min(receipt.stockedQty, dto.qty),
            receivedAt: receiptDate(dto.receivedAt),
            receivedByUserId: actor.id,
            receivedByName: changedBy,
          },
        },
      },
    });
    if (dto.stockUnitPrice != null) {
      await this.upsertOpeningCost(
        receipt.order.id,
        dto.qty,
        dto.stockUnitPrice,
        changedBy,
      );
    }
    if (dto.bomLines !== undefined) {
      await this.replaceBomLines(receipt.order.id, dto.bomLines);
    }
    await recordEditLog(this.prisma, {
      entityType: 'fg_receipt',
      entityId: receipt.id,
      reason: dto.editReason,
      changedBy,
    });
    return { success: true };
  }

  async deleteReceipt(id: string) {
    const receipt = await this.prisma.finishedGoodsReceipt.findUnique({
      where: { id },
      include: {
        order: { select: { shipmentLines: { select: { qty: true } } } },
      },
    });
    if (!receipt) throw new NotFoundException('Không tìm thấy phiếu nhập');
    const shippedQty = receipt.order.shipmentLines.reduce(
      (sum, line) => sum + line.qty,
      0,
    );
    if (shippedQty > 0) {
      throw new BadRequestException(
        `Đã xuất ${shippedQty} — không xóa phiếu nhập được`,
      );
    }
    await this.prisma.finishedGoodsReceipt.delete({ where: { id } });
    return { success: true };
  }

  /** Nhập mới trên Tồn — tự tạo mã đơn, không hiện trên danh sách sản xuất. */
  private async createStockEntry(
    dto: UpsertReceiptDto,
    actor: AuthUserPayload,
  ) {
    const description = dto.description?.trim();
    if (!description) throw new BadRequestException('Nhập tên thành phẩm');
    await this.assertUniqueStockName(description);
    const changedBy = actorName(actor);
    const receivedAt = receiptDate(dto.receivedAt);
    const unitPrice = dto.stockUnitPrice
      ? new Prisma.Decimal(dto.stockUnitPrice)
      : new Prisma.Decimal(0);
    const costAmount = unitPrice
      .mul(dto.qty)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const bomLines = await this.requireBomMaterials(
      this.prisma,
      dto.bomLines ?? [],
    );

    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.runTx(async (tx) => {
          const last = await tx.productionOrder.aggregate({
            _max: { seq: true },
          });
          const seq = (last._max.seq ?? 0) + 1;
          const code = orderCode(seq);
          await tx.productionOrder.create({
            data: {
              seq,
              code,
              status: ProductionStatus.FINISHING,
              source: ProductionSource.NVL,
              requestType: ProductionRequestType.RETAIL,
              qty: Math.max(dto.qty, 1),
              qtyUnit: dto.qtyUnit?.trim() || null,
              description,
              mainMaterial: dto.mainMaterial?.trim() || null,
              platingColor: dto.platingColor?.trim() || null,
              sizeLabel: dto.sizeLabel?.trim() || null,
              closedBy: changedBy,
              createdBy: changedBy,
              receivedDate: receivedAt,
              dueDate: receivedAt,
              leadTime: '—',
              trackingCode: `${STOCK_TRACKING_PREFIX}${code}`,
              receipt: {
                create: {
                  qty: dto.qty,
                  stockedQty: dto.qty,
                  receivedAt,
                  receivedByUserId: actor.id,
                  receivedByName: changedBy,
                },
              },
              ...(bomLines.length
                ? {
                    bomLines: {
                      create: bomLines,
                    },
                  }
                : {}),
              ...(costAmount.gt(0)
                ? {
                    costs: {
                      create: {
                        name: OPENING_COST_NAME,
                        amount: costAmount,
                        createdByName: changedBy,
                      },
                    },
                  }
                : {}),
            },
          });
        });
        return { success: true };
      } catch (error) {
        if (isUniqueViolation(error) && attempt < CREATE_RETRIES) continue;
        throw error;
      }
    }
  }

  private async assertUniqueStockName(
    description: string,
    excludeOrderId?: string,
  ) {
    const name = description.trim();
    if (!name) return;
    const found = await this.prisma.finishedGoodsReceipt.findFirst({
      where: {
        order: {
          description: { equals: name, mode: 'insensitive' },
          ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
        },
      },
      select: { id: true },
    });
    if (found) throw new ConflictException('Tên thành phẩm này đã có trên Tồn');
  }

  private async upsertOpeningCost(
    orderId: string,
    qty: number,
    unitPrice: string,
    changedBy: string,
  ) {
    const amount = new Prisma.Decimal(unitPrice)
      .mul(qty)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const existing = await this.prisma.productionOrderCost.findFirst({
      where: { orderId, name: OPENING_COST_NAME },
      select: { id: true },
    });
    if (amount.lte(0)) {
      if (existing) {
        await this.prisma.productionOrderCost.delete({
          where: { id: existing.id },
        });
      }
      return;
    }
    if (existing) {
      await this.prisma.productionOrderCost.update({
        where: { id: existing.id },
        data: { amount, createdByName: changedBy },
      });
      return;
    }
    await this.prisma.productionOrderCost.create({
      data: {
        orderId,
        name: OPENING_COST_NAME,
        amount,
        createdByName: changedBy,
      },
    });
  }

  private async requireReceiptOrder(code: string) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: code.trim().toUpperCase() },
      select: {
        id: true,
        code: true,
        receipt: { select: { id: true, qty: true, stockedQty: true } },
      },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    return order;
  }

  private async requireBomMaterials(
    db: Prisma.TransactionClient | PrismaService,
    lines: Array<{ materialId: string }>,
  ) {
    const ids = lines.map((line) => line.materialId.trim()).filter(Boolean);
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) {
      throw new BadRequestException('Không chọn trùng một mã NVL');
    }
    if (unique.length === 0) return [];
    const rows = await db.material.findMany({
      where: {
        id: { in: unique },
        warehouse: { code: NVL_WAREHOUSE_CODE },
      },
      select: { id: true },
    });
    if (rows.length !== unique.length) {
      throw new BadRequestException(
        'Mã NVL không hợp lệ hoặc không thuộc kho NVL chính',
      );
    }
    return unique.map((materialId, sortOrder) => ({ materialId, sortOrder }));
  }

  private async replaceBomLines(
    orderId: string,
    lines: Array<{ materialId: string }>,
  ) {
    const bom = await this.requireBomMaterials(this.prisma, lines);
    await this.prisma.runTx(async (tx) => {
      await tx.productionOrderBomLine.deleteMany({ where: { orderId } });
      if (bom.length === 0) return;
      await tx.productionOrderBomLine.createMany({
        data: bom.map((line) => ({
          id: randomUUID(),
          orderId,
          materialId: line.materialId,
          sortOrder: line.sortOrder,
        })),
      });
    });
  }

  async lookups() {
    const [customers, payments] = await Promise.all([
      this.prisma.shipment.findMany({
        distinct: ['customerName'],
        select: { customerName: true },
        orderBy: { customerName: 'asc' },
        take: 300,
      }),
      this.prisma.shipment.findMany({
        where: { paymentMethod: { not: null } },
        distinct: ['paymentMethod'],
        select: { paymentMethod: true },
        take: 50,
      }),
    ]);
    return {
      customers: customers.map((row) => row.customerName),
      paymentMethods: Array.from(
        new Set([
          ...DEFAULT_PAYMENT_METHODS,
          ...payments.map((row) => row.paymentMethod as string),
        ]),
      ),
    };
  }

  async listShipments(query: ListShipmentsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const keyword = query.search?.trim();
    const where: Prisma.ShipmentWhereInput = keyword
      ? {
          OR: [
            { code: { contains: keyword, mode: 'insensitive' } },
            { customerName: { contains: keyword, mode: 'insensitive' } },
            {
              lines: {
                some: {
                  order: { code: { contains: keyword, mode: 'insensitive' } },
                },
              },
            },
          ],
        }
      : {};

    const [rows, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        orderBy: { seq: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          lines: {
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true,
              qty: true,
              unitPrice: true,
              amount: true,
              costAmount: true,
              note: true,
              order: {
                select: {
                  code: true,
                  description: true,
                  sizeLabel: true,
                  mainMaterial: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.shipment.count({ where }),
    ]);

    const zero = new Prisma.Decimal(0);
    return {
      total,
      items: rows.map((row) => ({
        code: row.code,
        shippedAt: ymd(row.shippedAt),
        customerName: row.customerName,
        paymentMethod: row.paymentMethod,
        note: row.note,
        orderCodes: Array.from(
          new Set(row.lines.map((line) => line.order.code)),
        ),
        qty: row.lines.reduce((sum, line) => sum + line.qty, 0),
        amount: decStr(
          row.lines.reduce((sum, line) => sum.add(line.amount), zero),
        ),
        costAmount: decStr(
          row.lines.reduce((sum, line) => sum.add(line.costAmount), zero),
        ),
        autoIssued: row.autoIssued,
        createdByName: row.createdByName,
        createdAt: row.createdAt.toISOString(),
        lines: row.lines.map((line) => ({
          id: line.id,
          orderCode: line.order.code,
          description: line.order.description,
          sizeLabel: line.order.sizeLabel,
          mainMaterial: line.order.mainMaterial,
          qty: String(line.qty),
          unitPrice: decStr(line.unitPrice),
          amount: decStr(line.amount),
          note: line.note,
        })),
      })),
    };
  }

  async shipment(code: string) {
    return toShipment(await this.requireShipment(code));
  }

  async create(dto: UpsertShipmentDto, actor: AuthUserPayload) {
    const header = shipmentHeader(dto);
    const changedBy = actorName(actor);

    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const lines = await this.buildLines(tx, dto.lines);
          const last = await tx.shipment.aggregate({ _max: { seq: true } });
          const seq = (last._max.seq ?? 0) + 1;
          const shipment = await tx.shipment.create({
            data: {
              ...header,
              seq,
              code: shipmentCode(seq),
              createdByUserId: actor.id,
              createdByName: changedBy,
              lines: { create: lines },
            },
            select: { id: true, code: true },
          });
          await this.syncOrders(
            tx,
            lines.map((line) => line.orderId),
            shipment.code,
            changedBy,
          );
          return shipment;
        });
        return this.shipment(created.code);
      } catch (error) {
        // Hai người lập phiếu cùng lúc có thể lấy trùng số — thử lại với số kế tiếp.
        if (isUniqueViolation(error) && attempt < CREATE_RETRIES) continue;
        throw error;
      }
    }
  }

  async update(code: string, dto: UpsertShipmentDto, actor: AuthUserPayload) {
    const existing = await this.requireShipment(code);
    if (existing.autoIssued) {
      throw new BadRequestException(
        'Phiếu xuất do lên đơn tự tạo — sửa mã / số lượng trên đơn',
      );
    }
    const header = shipmentHeader(dto);
    const changedBy = actorName(actor);

    await this.prisma.$transaction(async (tx) => {
      // Xoá dòng cũ trước để phần kiểm tra tồn không tính chính phiếu đang sửa.
      await tx.shipmentLine.deleteMany({ where: { shipmentId: existing.id } });
      const lines = await this.buildLines(tx, dto.lines);
      await tx.shipment.update({
        where: { id: existing.id },
        data: {
          ...header,
          dataChangedAt: new Date(),
          lines: { create: lines },
        },
      });
      await this.syncOrders(
        tx,
        [
          ...existing.lines.map((line) => line.orderId),
          ...lines.map((line) => line.orderId),
        ],
        existing.code,
        changedBy,
      );
    });
    await recordEditLog(this.prisma, {
      entityType: 'fg_shipment',
      entityId: existing.code,
      reason: dto.editReason,
      changedBy,
    });
    return this.shipment(existing.code);
  }

  async remove(code: string, actor: AuthUserPayload) {
    const existing = await this.requireShipment(code);
    if (existing.autoIssued) {
      throw new BadRequestException(
        'Phiếu xuất do lên đơn tự tạo — xóa trên đơn',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.shipment.delete({ where: { id: existing.id } });
      await this.syncOrders(
        tx,
        existing.lines.map((line) => line.orderId),
        existing.code,
        actorName(actor),
        true,
      );
    });
    return { success: true };
  }

  async markPrinted(code: string) {
    const existing = await this.requireShipment(code);
    const updated = await this.prisma.shipment.update({
      where: { id: existing.id },
      data: { lastPrintedAt: new Date() },
      select: { lastPrintedAt: true },
    });
    return { lastPrintedAt: updated.lastPrintedAt?.toISOString() ?? null };
  }

  private async requireShipment(code: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: shipmentInclude,
    });
    if (!shipment)
      throw new NotFoundException('Không tìm thấy phiếu xuất hàng');
    return shipment;
  }

  /**
   * Kiểm tra tồn kho thành phẩm của từng đơn và chụp giá vốn lúc lập phiếu.
   * Gọi sau khi đã bỏ dòng cũ của phiếu đang sửa.
   */
  private async buildLines(
    tx: Prisma.TransactionClient,
    input: ShipmentLineDto[],
  ) {
    const requested = new Map<string, number>();
    for (const line of input) {
      const orderCode = line.orderCode.trim().toUpperCase();
      requested.set(orderCode, (requested.get(orderCode) ?? 0) + line.qty);
    }

    const orders = await tx.productionOrder.findMany({
      where: { code: { in: Array.from(requested.keys()) } },
      select: {
        id: true,
        code: true,
        receipt: { select: { stockedQty: true } },
        shipmentLines: { select: { qty: true } },
      },
    });
    const byCode = new Map(orders.map((order) => [order.code, order]));

    const costs = await this.costing.costingMany(
      orders.map((order) => order.id),
      tx,
    );
    const unitCosts = new Map<string, Prisma.Decimal>();
    for (const [orderCode, qty] of requested) {
      const order = byCode.get(orderCode);
      if (!order) {
        throw new BadRequestException(
          `Không tìm thấy đơn sản xuất ${orderCode}`,
        );
      }
      if (!order.receipt) {
        throw new BadRequestException(
          `Đơn ${orderCode} chưa vào kho thành phẩm`,
        );
      }
      const shipped = order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      const remaining = order.receipt.stockedQty - shipped;
      if (qty > remaining) {
        throw new BadRequestException(
          `Đơn ${orderCode} chỉ còn ${remaining} trong kho thành phẩm, không xuất ${qty} được`,
        );
      }
      const cost = costs.get(order.id);
      if (!cost) {
        throw new BadRequestException(
          `Không tính được giá vốn đơn ${orderCode}`,
        );
      }
      unitCosts.set(orderCode, cost.unitCostDecimal);
    }

    return input.map((line, index) => {
      const orderCode = line.orderCode.trim().toUpperCase();
      const order = byCode.get(orderCode)!;
      const unitPrice = new Prisma.Decimal(line.unitPrice);
      const unitCost = unitCosts.get(orderCode)!;
      return {
        orderId: order.id,
        qty: line.qty,
        unitPrice,
        amount: unitPrice.mul(line.qty).toDecimalPlaces(2),
        unitCost,
        costAmount: unitCost.mul(line.qty).toDecimalPlaces(2),
        note: line.note?.trim() || null,
        sortOrder: index,
      };
    });
  }

  /**
   * Cập nhật "Đã trả" = tổng đã xuất. Xuất đủ số lượng đơn thì Đã giao; bớt phiếu làm
   * đơn không còn đủ thì trả về Hoàn thiện.
   */
  private async syncOrders(
    tx: Prisma.TransactionClient,
    orderIds: string[],
    shipmentCode: string,
    changedBy: string,
    removed = false,
  ) {
    for (const orderId of new Set(orderIds)) {
      const order = await tx.productionOrder.findUnique({
        where: { id: orderId },
        select: {
          qty: true,
          status: true,
          returnedQty: true,
          receipt: { select: { qty: true } },
          shipmentLines: { select: { qty: true } },
        },
      });
      if (!order) continue;
      const shipped = order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      // Mốc "giao đủ" là số đã chốt hoàn thiện, không phải số đặt hàng: hàng hỏng dọc đường
      // không bao giờ lên kho nên đơn sẽ không bao giờ đủ nếu so với số đặt.
      const finishedQty = order.receipt?.qty ?? order.qty;
      const delivered = shipped > 0 && shipped >= finishedQty;
      const nextStatus = delivered
        ? ProductionStatus.DELIVERED
        : order.status === ProductionStatus.DELIVERED
          ? ProductionStatus.FINISHING
          : order.status;
      if (shipped === order.returnedQty && nextStatus === order.status)
        continue;

      await tx.productionOrder.update({
        where: { id: orderId },
        data: {
          returnedQty: shipped,
          status: nextStatus,
          ...(nextStatus !== order.status
            ? {
                statusLogs: {
                  create: {
                    fromStatus: order.status,
                    toStatus: nextStatus,
                    note: removed
                      ? `Xóa phiếu xuất ${shipmentCode}`
                      : `Phiếu xuất ${shipmentCode} (đã xuất ${shipped}/${finishedQty})`,
                    changedBy,
                  },
                },
              }
            : null),
        },
      });
    }
  }
}

function toShipment(row: ShipmentDetail) {
  const zero = new Prisma.Decimal(0);
  return {
    code: row.code,
    shippedAt: ymd(row.shippedAt),
    customerName: row.customerName,
    paymentMethod: row.paymentMethod,
    note: row.note,
    autoIssued: row.autoIssued,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastPrintedAt: row.lastPrintedAt?.toISOString() ?? null,
    dataChangedAt: row.dataChangedAt.toISOString(),
    lines: row.lines.map((line) => ({
      id: line.id,
      orderCode: line.order.code,
      description: line.order.description,
      sizeLabel: line.order.sizeLabel,
      size: line.order.size,
      mainMaterial: line.order.mainMaterial,
      imageUrl: line.order.images[0]?.url ?? null,
      qty: line.qty,
      unitPrice: decStr(line.unitPrice),
      amount: decStr(line.amount),
      unitCost: decStr(line.unitCost),
      costAmount: decStr(line.costAmount),
      note: line.note,
    })),
    totals: {
      qty: row.lines.reduce((sum, line) => sum + line.qty, 0),
      amount: decStr(
        row.lines.reduce((sum, line) => sum.add(line.amount), zero),
      ),
      costAmount: decStr(
        row.lines.reduce((sum, line) => sum.add(line.costAmount), zero),
      ),
    },
  };
}

function shipmentHeader(dto: UpsertShipmentDto) {
  const customerName = dto.customerName.trim();
  if (!customerName) throw new BadRequestException('Nhập khách hàng');
  return {
    shippedAt: new Date(`${dto.shippedAt.slice(0, 10)}T00:00:00.000Z`),
    customerName,
    paymentMethod: dto.paymentMethod?.trim() || null,
    note: dto.note?.trim() || null,
  };
}

export function shipmentCode(seq: number) {
  return `PX${String(seq).padStart(4, '0')}`;
}

function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function receiptDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function actorName(actor: { fullName: string; username: string }) {
  return actor.fullName.trim() || actor.username;
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
