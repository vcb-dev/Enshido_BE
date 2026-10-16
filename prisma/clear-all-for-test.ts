import { PrismaClient } from '@prisma/client';

// Pooler của Supabase (6543) dùng chung prepared statement nên TRUNCATE lỗi 42P05 — đi cổng trực tiếp.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

/**
 * Xoá dữ liệu nghiệp vụ để test lại: tạo đơn, lệnh SX, lệnh đúc, cây thông, kho
 * (vật tư + tồn + nhập/xuất) và nhân sự — chỉ giữ tài khoản admin cùng danh mục
 * cấu hình (kho, vị trí kho, đơn vị, màu, hình dạng, loại NVL, nhà cung cấp).
 */
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
      "production_stone_hold_images",
      "production_stone_holds",
      "production_stage_images",
      "production_stage_entries",
      "production_sub_ticket_top_ups",
      "production_sub_tickets",
      "production_order_images",
      "production_order_bom_lines",
      "production_orders",
      "casting_slip_images",
      "casting_slip_images_legacy",
      "casting_slip_orders",
      "casting_slips",
      "casting_slips_legacy_workflow",
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
  console.log('Đã xoá đơn tạo, lệnh SX, lệnh đúc, cây thông, vật tư và tồn/nhập/xuất.');

  const { count } = await prisma.user.deleteMany({
    where: { username: { not: 'admin' } },
  });
  console.log(`Đã xoá ${count} nhân sự, giữ lại tài khoản admin.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
