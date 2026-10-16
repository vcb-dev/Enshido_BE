import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Các bảng sẽ bị xoá — dump ra JSON làm phao cứu sinh trước khi TRUNCATE. */
const TABLES = [
  'edit_logs',
  'shipment_lines',
  'shipments',
  'finished_goods_receipts',
  'production_order_costs',
  'production_activity_logs',
  'production_status_logs',
  'production_material_requests',
  'production_stone_hold_images',
  'production_stone_holds',
  'production_stage_images',
  'production_stage_entries',
  'production_sub_ticket_top_ups',
  'production_sub_tickets',
  'production_order_images',
  'production_order_bom_lines',
  'production_orders',
  'casting_slip_images',
  'casting_slip_images_legacy',
  'casting_slip_orders',
  'casting_slips',
  'casting_slips_legacy_workflow',
  'casting_order_lines',
  'casting_orders',
  'btp_waiting_items',
  'stock_outbound_drafts',
  'stock_outbounds',
  'stock_inbounds',
  'stock_balances',
  'material_images',
  'materials',
  'users',
  'refresh_tokens',
];

async function main() {
  const dump: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    dump[table] = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`);
    console.log(`${table}: ${dump[table].length}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `db-backup/enshido-before-clear-${stamp}.json`;
  writeFileSync(
    file,
    JSON.stringify(dump, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
  console.log(`\nĐã lưu ${file}`);
}

main().finally(() => prisma.$disconnect());
