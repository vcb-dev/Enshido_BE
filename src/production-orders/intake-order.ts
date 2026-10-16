import { IntakeOrderStatus, Prisma, ProductionStatus } from '@prisma/client';

/**
 * Đơn tạo và lệnh sản xuất là MỘT bản ghi (`ProductionOrder`). Đơn đi qua luồng tạo → duyệt → 3D →
 * sáp → đúc → cắt cây có `intakeSeq`; chưa cắt cây (`cutAt` rỗng) thì còn "tiền-Nguội" và không hiện
 * ở danh sách lệnh sản xuất. Cắt cây thông chỉ đặt `cutAt` + chuyển WAIT_FILING trên chính bản ghi đó.
 */

/** Đơn đi qua luồng tạo đơn (kể cả đã cắt cây). */
export const INTAKE_ORDER_WHERE: Prisma.ProductionOrderWhereInput = {
  intakeSeq: { not: null },
};

/** Đơn còn ở các bước trước Nguội — chưa cắt cây thông. */
export const PRE_PRODUCTION_WHERE: Prisma.ProductionOrderWhereInput = {
  intakeSeq: { not: null },
  cutAt: null,
};

/** Điều kiện loại đơn tiền-Nguội khỏi mọi danh sách / lựa chọn của lệnh sản xuất. */
export const EXCLUDE_PRE_PRODUCTION: Prisma.ProductionOrderWhereInput = {
  NOT: PRE_PRODUCTION_WHERE,
};

export function intakeCode(seq: number) {
  return `DH${String(seq).padStart(3, '0')}`;
}

export function orderCode(seq: number) {
  return `A${String(seq).padStart(3, '0')}`;
}

const SX_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomSxCode() {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += SX_CODE_CHARS[Math.floor(Math.random() * SX_CODE_CHARS.length)];
  }
  return `S${suffix}`;
}

/** Trạng thái tiền-Nguội lưu trên `ProductionStatus` trùng tên với `IntakeOrderStatus`. */
export function toProductionStatus(
  status: IntakeOrderStatus,
): ProductionStatus {
  if (status === IntakeOrderStatus.WAIT_COOLING) {
    return ProductionStatus.WAIT_FILING;
  }
  return status as unknown as ProductionStatus;
}

/** Từ khi cắt cây, đơn hiện với luồng tạo đơn là WAIT_COOLING (đã sang Nguội). */
export function toIntakeStatus(order: {
  status: ProductionStatus;
  cutAt: Date | null;
}): IntakeOrderStatus {
  if (order.cutAt) return IntakeOrderStatus.WAIT_COOLING;
  return order.status as unknown as IntakeOrderStatus;
}

/** Điều kiện `where` theo trạng thái kiểu đơn tạo. */
export function intakeStatusWhere(
  status: IntakeOrderStatus,
): Prisma.ProductionOrderWhereInput {
  if (status === IntakeOrderStatus.WAIT_COOLING) {
    return { cutAt: { not: null } };
  }
  return { status: status as unknown as ProductionStatus, cutAt: null };
}

/**
 * Cấp seq mã A… cho đơn mới. Khoá advisory theo transaction để đơn tạo, đơn bù, đơn tạo tay và
 * hàng tồn không giành cùng số.
 */
export async function nextOrderSeq(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`
    WITH sequence_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtext('enshido_production_order_seq'))
    )
    SELECT 1::int AS locked FROM sequence_lock
  `;
  const last = await tx.productionOrder.findFirst({
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + 1;
}

/** Cấp seq mã DH… cho đơn hàng mới; lệnh bù dùng lại seq / mã DH của đơn gốc. */
export async function nextIntakeSeq(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`
    WITH sequence_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtext('enshido_intake_order_seq'))
    )
    SELECT 1::int AS locked FROM sequence_lock
  `;
  const last = await tx.productionOrder.findFirst({
    where: { intakeSeq: { not: null }, reworkOfOrderId: null },
    orderBy: { intakeSeq: 'desc' },
    select: { intakeSeq: true },
  });
  return (last?.intakeSeq ?? 0) + 1;
}
