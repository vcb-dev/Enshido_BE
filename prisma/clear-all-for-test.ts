import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Xóa dữ liệu nghiệp vụ để test lại — giữ user + danh mục + kho. */
async function main() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "refresh_tokens",
      "edit_logs",
      "shipment_lines",
      "shipments",
      "finished_goods_receipts",
      "production_order_costs",
      "production_activity_logs",
      "production_status_logs",
      "production_material_requests",
      "production_stone_holds",
      "production_stage_images",
      "production_stage_entries",
      "production_sub_tickets",
      "production_order_images",
      "production_order_bom_lines",
      "production_orders",
      "intake_order_images",
      "intake_orders",
      "casting_slip_images",
      "casting_slip_orders",
      "casting_slips",
      "casting_order_lines",
      "casting_orders",
      "btp_waiting_items",
      "stock_outbound_drafts",
      "stock_outbounds",
      "stock_inbounds",
      "stock_balances",
      "material_images",
      "materials"
    RESTART IDENTITY CASCADE;
  `);
  console.log('Đã xóa đơn tạo, phiếu đúc, lệnh SX, tồn/nhập/xuất.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
