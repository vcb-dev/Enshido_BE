import { Injectable } from '@nestjs/common';
không merge tạo pr thôiimport {
  INTAKE_ORDER_WHERE,
  toIntakeStatus,
} from '../production-orders/intake-order';
import { PrismaService } from '../prisma/prisma.service';

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
      this.prisma.productionOrder.aggregate({
        where: INTAKE_ORDER_WHERE,
        _max: { updatedAt: true },
      }),
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
    const rows = await this.prisma.productionOrder.findMany({
      where: INTAKE_ORDER_WHERE,
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: 400,
      select: {
        id: true,
        code: true,
        intakeCode: true,
        sxCode: true,
        status: true,
        cutAt: true,
        requestType: true,
        productName: true,
        qty: true,
        trackingCode: true,
        closedBy: true,
        description: true,
        receivedDate: true,
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
        code: row.intakeCode ?? row.code,
        sxCode: row.sxCode ?? row.code,
        status: toIntakeStatus(row),
        requestType: row.requestType,
        productName: row.productName,
        qty: row.qty,
        trackingCode: row.trackingCode,
        placedBy: row.closedBy,
        description: row.description,
        createdDate: row.receivedDate.toISOString().slice(0, 10),
        dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
        hasMold: row.hasMold,
        model3dUrl: row.model3dUrl,
        productWeightGram:
          row.productWeightGram != null
            ? row.productWeightGram.toString()
            : null,
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
