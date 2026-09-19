import {
  BadRequestException,
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
import { PrismaService } from '../prisma/prisma.service';
import { ProductionCostingService } from '../production-orders/production-costing.service';
import { orderCode } from '../production-orders/production-orders.service';
import { availabilityOf, decStr } from '../util/money';
import {
  ListShipmentsQuery,
  ShipmentLineDto,
  UpsertReceiptDto,
  UpsertShipmentDto,
} from './dto/shipment.dto';

const DEFAULT_PAYMENT_METHODS = ['Tiền mặt', 'Chuyển khoản', 'VCB'];
const OPENING_COST_NAME = 'Giá vốn đầu kỳ';
const STOCK_TRACKING_PREFIX = 'KHO-';

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
      where: keyword
        ? {
            order: {
              OR: [
                { code: { contains: keyword, mode: 'insensitive' } },
                { description: { contains: keyword, mode: 'insensitive' } },
              ],
            },
          }
        : undefined,
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
            trackingCode: true,
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
    const items = [];
    for (const receipt of receipts) {
      const shippedQty = receipt.order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      const remainingQty = receipt.qty - shippedQty;
      const cost = await this.costing.costing(receipt.order.id);
      const isOpening = (receipt.order.trackingCode ?? '').startsWith(
        STOCK_TRACKING_PREFIX,
      );
      const openingQty = isOpening
        ? new Prisma.Decimal(receipt.qty)
        : zero;
      const inQty = isOpening ? zero : new Prisma.Decimal(receipt.qty);
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
        imageUrl: receipt.order.images[0]?.url ?? null,
        isOpening,
        openingQty: decStr(openingQty),
        openingAmount: decStr(openingAmount),
        inQty: decStr(inQty),
        inAmount: decStr(inAmount),
        outQty: decStr(outQty),
        outAmount: decStr(outAmount),
        qty: decStr(qty),
        amount: decStr(amount),
        receivedQty: receipt.qty,
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
                { NOT: { trackingCode: { startsWith: STOCK_TRACKING_PREFIX } } },
              ],
            },
            ...(keyword
              ? [
                  {
                    OR: [
                      { code: { contains: keyword, mode: 'insensitive' as const } },
                      { description: { contains: keyword, mode: 'insensitive' as const } },
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
    const items = [];
    for (const receipt of receipts) {
      const shippedQty = receipt.order.shipmentLines.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      const cost = await this.costing.costing(receipt.order.id);
      const qty = new Prisma.Decimal(receipt.qty);
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
        unitPrice: cost.unitCost,
        amount: decStr(amount),
        shippedQty,
        remainingQty: receipt.qty - shippedQty,
        receivedAt: ymd(receipt.receivedAt),
        receivedByName: receipt.receivedByName,
        note: null,
      });
    }
    return { items };
  }

  /** Đơn chưa vào kho thành phẩm — chọn khi Nhập thành phẩm. */
  async orderOptions(search?: string) {
    const keyword = search?.trim();
    const rows = await this.prisma.productionOrder.findMany({
      where: {
        receipt: { is: null },
        NOT: { trackingCode: { startsWith: STOCK_TRACKING_PREFIX } },
        ...(keyword
          ? {
              OR: [
                { code: { contains: keyword, mode: 'insensitive' } },
                { description: { contains: keyword, mode: 'insensitive' } },
                { trackingCode: { contains: keyword, mode: 'insensitive' } },
              ],
            }
          : undefined),
      },
      orderBy: { seq: 'desc' },
      take: 200,
      select: {
        code: true,
        description: true,
        qty: true,
        qtyUnit: true,
        sizeLabel: true,
        mainMaterial: true,
      },
    });
    return { items: rows };
  }

  async createReceipt(dto: UpsertReceiptDto, actor: AuthUserPayload) {
    if (!dto.orderCode?.trim()) {
      return this.createStockEntry(dto, actor);
    }
    if (dto.qty < 1) {
      throw new BadRequestException('Số lượng nhập phải lớn hơn 0');
    }
    const order = await this.requireReceiptOrder(dto.orderCode);
    if (order.receipt) {
      throw new BadRequestException('Đơn đã có trong kho thành phẩm');
    }
    await this.prisma.productionOrder.update({
      where: { id: order.id },
      data: {
        ...(dto.sizeLabel !== undefined ? { sizeLabel: dto.sizeLabel.trim() || null } : {}),
        ...(dto.qtyUnit !== undefined ? { qtyUnit: dto.qtyUnit.trim() || null } : {}),
        receipt: {
          create: {
            qty: dto.qty,
            receivedAt: receiptDate(dto.receivedAt),
            receivedByUserId: actor.id,
            receivedByName: actorName(actor),
          },
        },
      },
    });
    return { success: true };
  }

  async updateReceipt(id: string, dto: UpsertReceiptDto, actor: AuthUserPayload) {
    const receipt = await this.prisma.finishedGoodsReceipt.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
            code: true,
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
    if (dto.qty < shippedQty) {
      throw new BadRequestException(
        `Đã xuất ${shippedQty} — số lượng nhập không được nhỏ hơn số đã xuất`,
      );
    }
    const changedBy = actorName(actor);
    await this.prisma.productionOrder.update({
      where: { id: receipt.order.id },
      data: {
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.mainMaterial !== undefined
          ? { mainMaterial: dto.mainMaterial.trim() || null }
          : {}),
        ...(dto.sizeLabel !== undefined ? { sizeLabel: dto.sizeLabel.trim() || null } : {}),
        ...(dto.qtyUnit !== undefined ? { qtyUnit: dto.qtyUnit.trim() || null } : {}),
        receipt: {
          update: {
            qty: dto.qty,
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
  private async createStockEntry(dto: UpsertReceiptDto, actor: AuthUserPayload) {
    const description = dto.description?.trim();
    if (!description) throw new BadRequestException('Nhập tên thành phẩm');
    const changedBy = actorName(actor);
    const receivedAt = receiptDate(dto.receivedAt);
    const unitPrice = dto.stockUnitPrice
      ? new Prisma.Decimal(dto.stockUnitPrice)
      : new Prisma.Decimal(0);
    const costAmount = unitPrice.mul(dto.qty).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);

    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.runTx(async (tx) => {
          const last = await tx.productionOrder.aggregate({ _max: { seq: true } });
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
                  receivedAt,
                  receivedByUserId: actor.id,
                  receivedByName: changedBy,
                },
              },
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
        await this.prisma.productionOrderCost.delete({ where: { id: existing.id } });
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
        receipt: { select: { id: true } },
      },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    return order;
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
        receipt: { select: { qty: true } },
        shipmentLines: { select: { qty: true } },
      },
    });
    const byCode = new Map(orders.map((order) => [order.code, order]));

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
      const remaining = order.receipt.qty - shipped;
      if (qty > remaining) {
        throw new BadRequestException(
          `Đơn ${orderCode} chỉ còn ${remaining} trong kho thành phẩm, không xuất ${qty} được`,
        );
      }
      const cost = await this.costing.costing(order.id, tx);
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
                      : `Phiếu xuất ${shipmentCode} (đã xuất ${shipped}/${order.qty})`,
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
