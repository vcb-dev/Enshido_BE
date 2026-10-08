import {
  Prisma,
  ProductionImageKind,
  ProductionRequestType,
  ProductionStatus,
} from '@prisma/client';
import { toIntakeStatus } from '../production-orders/intake-order';

const intakeListImageKinds: ProductionImageKind[] = [
  ProductionImageKind.DETAIL,
  ProductionImageKind.PRODUCT,
  ProductionImageKind.CASTING_TREE,
];

export const intakeListSelect = {
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
  rejectReason: true,
  rejectedByName: true,
  rejectedAt: true,
  stoneCount: true,
  stoneWeight: true,
  createdAt: true,
  castingSlipLine: {
    select: { slip: { select: { code: true, status: true } } },
  },
  images: {
    where: { kind: { in: intakeListImageKinds } },
    orderBy: [{ kind: 'asc' as const }, { sortOrder: 'asc' as const }],
    take: 4,
    select: {
      kind: true,
      url: true,
      publicId: true,
      width: true,
      height: true,
    },
  },
} satisfies Prisma.ProductionOrderSelect;

/** Dùng chung list (ảnh lọc) và chi tiết sau mutate — không bó Prisma payload một include cố định. */
type IntakeRow = {
  reworkOfOrderId?: string | null;
  id: string;
  code: string;
  intakeCode: string | null;
  sxCode: string | null;
  status: ProductionStatus;
  cutAt: Date | null;
  requestType: ProductionRequestType;
  productName: string | null;
  qty: number;
  trackingCode: string | null;
  closedBy: string | null;
  description: string | null;
  receivedDate: Date;
  dueDate: Date | null;
  hasMold: boolean | null;
  model3dUrl: string | null;
  productWeightGram: Prisma.Decimal | null;
  castingTreeWeightGram: Prisma.Decimal | null;
  waxCheckedWeightGram: Prisma.Decimal | null;
  waxCheckedByName: string | null;
  rejectReason: string | null;
  rejectedByName: string | null;
  rejectedAt: Date | null;
  /** Đá theo 3D (khai ở bước 3D / bơm sáp) — mốc hao hụt Vào đá. */
  stoneCount: number | null;
  stoneWeight: Prisma.Decimal | null;
  createdAt: Date;
  images: {
    kind: ProductionImageKind;
    url: string;
    publicId: string;
    width: number | null;
    height: number | null;
  }[];
  castingSlipLine?: { slip?: { code: string; status: string } | null } | null;
};

export function toIntakeRow(row: IntakeRow) {
  return {
    id: row.id,
    reworkOfOrderId: row.reworkOfOrderId ?? null,
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
    rejectReason: row.rejectReason,
    rejectedByName: row.rejectedByName,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    stoneCount3d: row.stoneCount,
    stoneWeight3dGram:
      row.stoneWeight != null ? row.stoneWeight.toString() : null,
    /** Phiếu đúc đang giữ đơn (kể cả phiếu chưa cấp vật tư). */
    castingSlip: row.castingSlipLine?.slip
      ? {
          code: row.castingSlipLine.slip.code,
          status: row.castingSlipLine.slip.status,
        }
      : null,
    /** Đã cắt cây = đã vào lệnh sản xuất (Nguội); cùng bản ghi nên mã A… có từ lúc tạo. */
    productionOrderCode: row.cutAt ? row.code : null,
    createdAt: row.createdAt.toISOString(),
    images: row.images.map((image) => ({
      kind: image.kind,
      url: image.url,
      publicId: image.publicId,
      width: image.width,
      height: image.height,
    })),
  };
}
