import { Injectable, NotFoundException } from '@nestjs/common';
import { MetalKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decStr } from '../util/money';
import { recoveredOf, silverLossOf } from './stage-math';
import { STAGE_LABEL } from './production-orders.service';

type Db = Prisma.TransactionClient | PrismaService;

const GRAM_UNITS = new Set(['g', 'gr', 'gram', 'grams', 'gam']);

function isGram(unitName: string) {
  return GRAM_UNITS.has(unitName.trim().toLowerCase());
}

/** Tiền Việt không có số lẻ — làm tròn về đồng (half-up). */
const money = (value: Prisma.Decimal) =>
  value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);

/**
 * Chi phí sản xuất của một đơn:
 *   NVL xuất gắn đơn − (bạc + BTP thu hồi) × giá bạc + tiền công các khâu + chi phí khác.
 * Hao hụt bạc quy ra tiền chỉ để theo dõi — đã nằm trong bạc xuất nên không cộng thêm.
 */
@Injectable()
export class ProductionCostingService {
  constructor(private readonly prisma: PrismaService) {}

  async costingByCode(code: string) {
    const order = await this.prisma.productionOrder.findUnique({
      where: { code: code.trim().toUpperCase() },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { unitCostDecimal, ...result } = await this.costing(order.id);
    return result;
  }

  /** Nhận `tx` để phiếu xuất hàng chụp chi phí trong cùng transaction. */
  async costing(orderId: string, db: Db = this.prisma) {
    const zero = new Prisma.Decimal(0);
    const [order, outbounds] = await Promise.all([
      db.productionOrder.findUnique({
        where: { id: orderId },
        select: {
          qty: true,
          stages: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              stage: true,
              attempt: true,
              craftsmanName: true,
              returnedAt: true,
              handedSilverWeight: true,
              returnedSilverWeight: true,
              btpRecoveredWeight: true,
              silverRecoveredWeight: true,
              laborCost: true,
            },
          },
          costs: { orderBy: { createdAt: 'asc' } },
        },
      }),
      db.stockOutbound.findMany({
        where: {
          productionOrderId: orderId,
          applyToStock: true,
          qty: { gt: 0 },
        },
        orderBy: [{ issuedAt: 'asc' }, { sortOrder: 'asc' }],
        include: {
          warehouse: { select: { code: true, shortName: true } },
          material: { select: { metalKind: true } },
          unit: { select: { name: true } },
        },
      }),
    ]);
    if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');

    const warnings: string[] = [];

    // Phiếu cũ có thể chưa lưu thành tiền — tính lại từ đơn giá xuất như bảng xuất kho.
    const materials = outbounds.map((row) => {
      const amount = row.amount.gt(0)
        ? row.amount
        : money(row.qty.mul(row.inboundUnitPrice));
      const unitName = row.unit?.name ?? row.unitName;
      const silver = row.material?.metalKind === MetalKind.SILVER;
      if (silver && !isGram(unitName)) {
        warnings.push(
          `${row.name} là bạc nhưng đơn vị "${unitName}" không phải gram — không dùng để tính giá bạc`,
        );
      }
      return { row, amount, unitName, silverGram: silver && isGram(unitName) };
    });

    const materialTotal = materials.reduce(
      (sum, item) => sum.add(item.amount),
      zero,
    );
    const silverLines = materials.filter((item) => item.silverGram);
    const silverGrams = silverLines.reduce(
      (sum, item) => sum.add(item.row.qty),
      zero,
    );
    const silverAmount = silverLines.reduce(
      (sum, item) => sum.add(item.amount),
      zero,
    );
    const silverUnitPrice = silverGrams.gt(0)
      ? silverAmount.div(silverGrams).toDecimalPlaces(4)
      : null;

    const returned = order.stages.filter((entry) => entry.returnedAt);
    const recoveredGrams = returned.reduce(
      (sum, entry) => sum.add(recoveredOf(entry)),
      zero,
    );
    const lossGrams = returned.reduce(
      (sum, entry) => sum.add(silverLossOf(entry) ?? zero),
      zero,
    );
    if (recoveredGrams.gt(0) && !silverUnitPrice) {
      warnings.push(
        'Có bạc / BTP thu hồi nhưng chưa có phiếu xuất bạc (gram) gắn đơn — chưa trừ được tiền thu hồi',
      );
    }
    const recoveredAmount = silverUnitPrice
      ? money(recoveredGrams.mul(silverUnitPrice))
      : zero;

    const labor = order.stages
      .filter((entry) => entry.laborCost != null)
      .map((entry) => ({
        stageEntryId: entry.id,
        stage: entry.stage,
        stageLabel: STAGE_LABEL[entry.stage],
        attempt: entry.attempt,
        craftsmanName: entry.craftsmanName,
        amount: entry.laborCost as Prisma.Decimal,
      }));
    const laborTotal = labor.reduce((sum, item) => sum.add(item.amount), zero);
    const otherTotal = order.costs.reduce(
      (sum, item) => sum.add(item.amount),
      zero,
    );

    const total = materialTotal
      .sub(recoveredAmount)
      .add(laborTotal)
      .add(otherTotal);
    const unitCost = order.qty > 0 ? money(total.div(order.qty)) : money(total);

    return {
      qty: order.qty,
      materials: materials.map(({ row, amount, unitName, silverGram }) => ({
        id: row.id,
        issuedAt: row.issuedAt.toISOString().slice(0, 10),
        warehouseCode: row.warehouse.code,
        warehouseName: row.warehouse.shortName,
        name: row.name,
        sku: row.sku,
        qty: decStr(row.qty),
        unit: unitName,
        unitPrice: decStr(row.inboundUnitPrice),
        amount: decStr(amount),
        isSilver: silverGram,
      })),
      materialTotal: decStr(materialTotal),
      silver: {
        grams: decStr(silverGrams),
        amount: decStr(silverAmount),
        unitPrice: silverUnitPrice ? decStr(silverUnitPrice) : null,
      },
      recovered: {
        grams: decStr(recoveredGrams),
        amount: decStr(recoveredAmount),
      },
      silverLoss: {
        grams: decStr(lossGrams),
        amount: silverUnitPrice
          ? decStr(money(lossGrams.mul(silverUnitPrice)))
          : null,
      },
      labor: labor.map((item) => ({ ...item, amount: decStr(item.amount) })),
      laborTotal: decStr(laborTotal),
      others: order.costs.map((item) => ({
        id: item.id,
        name: item.name,
        amount: decStr(item.amount),
        note: item.note,
        createdByName: item.createdByName,
        createdAt: item.createdAt.toISOString(),
      })),
      otherTotal: decStr(otherTotal),
      total: decStr(total),
      unitCost: decStr(unitCost),
      /** Giá trị Decimal dùng khi chụp chi phí lên phiếu xuất. */
      unitCostDecimal: unitCost,
      warnings,
    };
  }
}
