import { Injectable } from '@nestjs/common';
import { IntakeOrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PIPELINE: IntakeOrderStatus[] = [
  IntakeOrderStatus.PENDING_APPROVAL,
  IntakeOrderStatus.APPROVED,
  IntakeOrderStatus.READY_FOR_PRODUCTION,
  IntakeOrderStatus.PENDING_WAREHOUSE_CONFIRMATION,
  IntakeOrderStatus.WAX_PRINTED,
  IntakeOrderStatus.WAX_CONFIRMED,
  IntakeOrderStatus.WAIT_CASTING,
  IntakeOrderStatus.CASTING,
  IntakeOrderStatus.CAST_PENDING_CONFIRMATION,
  IntakeOrderStatus.CAST_DONE,
  IntakeOrderStatus.WAIT_COOLING,
];

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? '';
}

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  private revisionCache: {
    at: number;
    value: { intake: string; production: string; casting: string };
  } | null = null;

  /** 3 MAX — FE poll để biết tab/chip cần làm mới, không kéo cả danh sách. */
  async revision() {
    const now = Date.now();
    if (this.revisionCache && now - this.revisionCache.at < 2_500) {
      return this.revisionCache.value;
    }
    const [intake, production, casting] = await Promise.all([
      this.prisma.intakeOrder.aggregate({ _max: { updatedAt: true } }),
      this.prisma.productionOrder.aggregate({ _max: { dataChangedAt: true } }),
      this.prisma.castingSlip.aggregate({ _max: { updatedAt: true } }),
    ]);
    const value = {
      intake: iso(intake._max.updatedAt),
      production: iso(production._max.dataChangedAt),
      casting: iso(casting._max.updatedAt),
    };
    this.revisionCache = { at: now, value };
    return value;
  }

  /** Đơn tạo đang trong pipeline — đủ để vá chip/nút, không kèm ảnh. */
  async intakeLive() {
    const rows = await this.prisma.intakeOrder.findMany({
      where: { status: { in: PIPELINE } },
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: 400,
      select: {
        id: true,
        code: true,
        sxCode: true,
        status: true,
        requestType: true,
        productName: true,
        qty: true,
        trackingCode: true,
        placedBy: true,
        description: true,
        createdDate: true,
        dueDate: true,
        hasMold: true,
        model3dUrl: true,
        productWeightGram: true,
        castingTreeWeightGram: true,
        waxCheckedWeightGram: true,
        waxCheckedByName: true,
        createdAt: true,
        updatedAt: true,
        castingSlipLine: {
          select: { slip: { select: { code: true, status: true } } },
        },
      },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        sxCode: row.sxCode,
        status: row.status,
        requestType: row.requestType,
        productName: row.productName,
        qty: row.qty,
        trackingCode: row.trackingCode,
        placedBy: row.placedBy,
        description: row.description,
        createdDate: row.createdDate.toISOString().slice(0, 10),
        dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
        hasMold: row.hasMold,
        model3dUrl: row.model3dUrl,
        productWeightGram:
          row.productWeightGram != null ? row.productWeightGram.toString() : null,
        castingTreeWeightGram:
          row.castingTreeWeightGram != null
            ? row.castingTreeWeightGram.toString()
            : null,
        waxCheckedWeightGram:
          row.waxCheckedWeightGram != null
            ? row.waxCheckedWeightGram.toString()
            : null,
        waxCheckedByName: row.waxCheckedByName,
        castingSlip: row.castingSlipLine?.slip
          ? {
              code: row.castingSlipLine.slip.code,
              status: row.castingSlipLine.slip.status,
            }
          : null,
        createdAt: row.createdAt.toISOString(),
        images: [],
      })),
    };
  }
}
