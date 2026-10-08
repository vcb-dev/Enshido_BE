import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  INTAKE_ORDER_WHERE,
  toIntakeStatus,
} from '../production-orders/intake-order';
import { dbTable } from '../prisma/database-url';
import { PrismaService } from '../prisma/prisma.service';

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? '';
}

type Revision = { intake: string; production: string; casting: string };

const REVISION_CACHE_MS = 8_000;

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  private revisionCache: { at: number; value: Revision } | null = null;
  private revisionInflight: Promise<Revision> | null = null;

  /**
   * 1 câu MAX (không 3 aggregate song song) — FE poll để biết tab/chip cần làm mới.
   * Nhiều tab cùng lúc dùng một kết quả; pool hết chỗ thì trả bản cache cũ.
   */
  async revision() {
    const now = Date.now();
    if (this.revisionCache && now - this.revisionCache.at < REVISION_CACHE_MS) {
      return this.revisionCache.value;
    }
    if (this.revisionInflight) return this.revisionInflight;
    this.revisionInflight = this.loadRevision()
      .then((value) => {
        this.revisionCache = { at: Date.now(), value };
        return value;
      })
      .catch((err: unknown) => {
        if (this.revisionCache) return this.revisionCache.value;
        throw err;
      })
      .finally(() => {
        this.revisionInflight = null;
      });
    return this.revisionInflight;
  }

  private async loadRevision(): Promise<Revision> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const [row] = await this.prisma.$queryRaw<
          Array<{
            intake: Date | null;
            production: Date | null;
            casting: Date | null;
          }>
        >(Prisma.sql`
          SELECT
            (SELECT MAX(updated_at) FROM ${dbTable('production_orders')} WHERE intake_seq IS NOT NULL) AS intake,
            (SELECT MAX(data_changed_at) FROM ${dbTable('production_orders')}) AS production,
            (SELECT MAX(updated_at) FROM ${dbTable('casting_slips')}) AS casting
        `);
        return {
          intake: iso(row?.intake),
          production: iso(row?.production),
          casting: iso(row?.casting),
        };
      } catch (err) {
        last = err;
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as { code?: string }).code
            : undefined;
        if ((code !== 'P2024' && code !== 'P1001') || attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    throw last;
  }

  /** Đơn tạo đang trong pipeline — đủ để vá chip/nút, không kèm ảnh. */
  async intakeLive() {
    const rows = await this.prisma.productionOrder.findMany({
      where: INTAKE_ORDER_WHERE,
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: 400,
      select: {
        id: true,
        reworkOfOrderId: true,
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
        reworkOfOrderId: row.reworkOfOrderId,
        productionOrderCode: row.cutAt ? row.code : null,
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
