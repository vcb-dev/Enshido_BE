import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductionImageKind, ProductionStatus } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionCostingService } from '../production-orders/production-costing.service';
import { decStr } from '../util/money';
import {
  ListShipmentsQuery,
  ShipmentLineDto,
  UpsertShipmentDto,
} from './dto/shipment.dto';

const DEFAULT_PAYMENT_METHODS = ['Tiền mặt', 'Chuyển khoản', 'VCB'];

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

  /** Đơn đang có hàng trong kho thành phẩm: tồn = nhập − đã xuất. */
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
            status: true,
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

    const inStock = receipts
      .map((receipt) => {
        const shippedQty = receipt.order.shipmentLines.reduce(
          (sum, line) => sum + line.qty,
          0,
        );
        return { receipt, shippedQty, remainingQty: receipt.qty - shippedQty };
      })
      .filter((item) => item.remainingQty > 0);

    // Tính tuần tự: pool kết nối nhỏ, mỗi đơn cần vài truy vấn chi phí.
    const items = [];
    for (const { receipt, shippedQty, remainingQty } of inStock) {
      const cost = await this.costing.costing(receipt.order.id);
      items.push({
        orderCode: receipt.order.code,
        description: receipt.order.description,
        requestType: receipt.order.requestType,
        sizeLabel: receipt.order.sizeLabel,
        mainMaterial: receipt.order.mainMaterial,
        imageUrl: receipt.order.images[0]?.url ?? null,
        receivedQty: receipt.qty,
        shippedQty,
        remainingQty,
        receivedAt: receipt.receivedAt.toISOString(),
        receivedByName: receipt.receivedByName,
        unitCost: cost.unitCost,
        stockValue: decStr(
          cost.unitCostDecimal.mul(remainingQty).toDecimalPlaces(2),
        ),
        costWarnings: cost.warnings.length,
      });
    }
    return { items };
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
            select: {
              qty: true,
              amount: true,
              costAmount: true,
              order: { select: { code: true } },
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
        createdByName: row.createdByName,
        createdAt: row.createdAt.toISOString(),
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

function actorName(actor: { fullName: string; username: string }) {
  return actor.fullName.trim() || actor.username;
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
