import { Prisma, PrismaClient } from '@prisma/client';
import { dbTable } from '../src/prisma/database-url';

const prisma = new PrismaClient();

/** Xóa tạo đơn + lệnh SX + lệnh/phiếu đúc. Giữ user, danh mục, kho và tồn không gắn đơn. */
async function main() {
  const affected = await prisma.$transaction(
    async (tx) => {
      const linkedInbounds = await tx.stockInbound.findMany({
        where: {
          OR: [{ productionOrderId: { not: null } }, { autoIssued: true }],
        },
        select: { warehouseId: true, materialId: true },
      });
      const linkedOutbounds = await tx.stockOutbound.findMany({
        where: { productionOrderId: { not: null } },
        select: { warehouseId: true, materialId: true },
      });
      const keys = new Map<string, { warehouseId: string; materialId: string }>();
      for (const row of [...linkedInbounds, ...linkedOutbounds]) {
        if (!row.materialId) continue;
        keys.set(`${row.warehouseId}:${row.materialId}`, {
          warehouseId: row.warehouseId,
          materialId: row.materialId,
        });
      }

      const holds = await tx.productionStoneHold.deleteMany({});
      const requests = await tx.productionMaterialRequest.deleteMany({});
      const drafts = await tx.stockOutboundDraft.deleteMany({});
      const outbounds = await tx.stockOutbound.deleteMany({
        where: { productionOrderId: { not: null } },
      });
      const restInboundIds = (
        await tx.castingSlip.findMany({
          where: { restInboundId: { not: null } },
          select: { restInboundId: true },
        })
      )
        .map((row) => row.restInboundId)
        .filter((id): id is string => Boolean(id));
      if (restInboundIds.length) {
        const restInbounds = await tx.stockInbound.findMany({
          where: { id: { in: restInboundIds } },
          select: { warehouseId: true, materialId: true },
        });
        for (const row of restInbounds) {
          if (!row.materialId) continue;
          keys.set(`${row.warehouseId}:${row.materialId}`, {
            warehouseId: row.warehouseId,
            materialId: row.materialId,
          });
        }
      }
      const inbounds = await tx.stockInbound.deleteMany({
        where: {
          OR: [
            { productionOrderId: { not: null } },
            { autoIssued: true },
            ...(restInboundIds.length ? [{ id: { in: restInboundIds } }] : []),
          ],
        },
      });

      const shipmentLines = await tx.shipmentLine.deleteMany({});
      const shipments = await tx.shipment.deleteMany({});
      const receipts = await tx.finishedGoodsReceipt.deleteMany({});
      const costs = await tx.productionOrderCost.deleteMany({});
      const activity = await tx.productionActivityLog.deleteMany({});
      const statusLogs = await tx.productionStatusLog.deleteMany({});
      const stageImages = await tx.productionStageImage.deleteMany({});
      const stages = await tx.productionStageEntry.deleteMany({});
      const tickets = await tx.productionSubTicket.deleteMany({});
      const orderImages = await tx.productionOrderImage.deleteMany({});
      const bom = await tx.productionOrderBomLine.deleteMany({});
      const orders = await tx.productionOrder.deleteMany({});

      const slipImages = await tx.castingSlipImage.deleteMany({});
      const slipOrders = await tx.castingSlipOrder.deleteMany({});
      const slips = await tx.castingSlip.deleteMany({});
      const castLines = await tx.castingOrderLine.deleteMany({});
      const castOrders = await tx.castingOrder.deleteMany({});

      const intakeImages = await tx.intakeOrderImage.deleteMany({});
      const intakes = await tx.intakeOrder.deleteMany({});

      for (const { warehouseId, materialId } of keys.values()) {
        await recomputeStockBalance(tx, warehouseId, materialId);
      }

      return {
        intakes: intakes.count,
        orders: orders.count,
        slips: slips.count,
        castOrders: castOrders.count,
        inbounds: inbounds.count,
        outbounds: outbounds.count,
        drafts: drafts.count,
        extras: {
          shipmentLines: shipmentLines.count,
          shipments: shipments.count,
          receipts: receipts.count,
          costs: costs.count,
          activity: activity.count,
          statusLogs: statusLogs.count,
          holds: holds.count,
          requests: requests.count,
          stageImages: stageImages.count,
          stages: stages.count,
          tickets: tickets.count,
          orderImages: orderImages.count,
          bom: bom.count,
          slipImages: slipImages.count,
          slipOrders: slipOrders.count,
          castLines: castLines.count,
          intakeImages: intakeImages.count,
        },
      };
    },
    { timeout: 60_000 },
  );

  console.log(
    `Đã xóa ${affected.intakes} đơn tạo, ${affected.orders} lệnh SX, ${affected.slips} phiếu đúc, ${affected.castOrders} lệnh đúc.`,
  );
  console.log(
    `Gỡ ${affected.inbounds} phiếu nhập / ${affected.outbounds} phiếu xuất / ${affected.drafts} phiếu nháp gắn đơn (đã tính lại tồn).`,
  );
}

async function recomputeStockBalance(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  materialId: string,
) {
  await tx.$executeRaw`
    INSERT INTO ${dbTable('stock_balances')} (
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
    LEFT JOIN ${dbTable('stock_balances')} b ON b.material_id = ${materialId}::uuid
    LEFT JOIN (
      SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(amount), 0) AS amount
      FROM ${dbTable('stock_inbounds')}
      WHERE warehouse_id = ${warehouseId}::uuid
        AND material_id = ${materialId}::uuid
        AND apply_to_stock = true
        AND qty > 0
    ) i ON true
    LEFT JOIN (
      SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(amount), 0) AS amount
      FROM ${dbTable('stock_outbounds')}
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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
