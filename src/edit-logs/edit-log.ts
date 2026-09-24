import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export type EditEntityType =
  | 'production_order'
  | 'stock'
  | 'inbound'
  | 'outbound'
  | 'fg_stock'
  | 'fg_receipt'
  | 'fg_shipment'
  | 'location'
  | 'catalog'
  | 'btp_waiting'
  | 'user'
  | 'order_cost'
  | 'stage_labor';

export function requireEditReason(reason: string | undefined) {
  const value = reason?.trim();
  if (!value) throw new BadRequestException('Nhập lý do chỉnh sửa');
  return value;
}

export async function recordEditLog(
  db: PrismaService | Prisma.TransactionClient,
  params: {
    entityType: EditEntityType;
    entityId: string;
    reason: string | undefined;
    changedBy: string;
  },
) {
  const reason = requireEditReason(params.reason);
  await db.editLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      reason,
      changedBy: params.changedBy,
    },
  });
}
