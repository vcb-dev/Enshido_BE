import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MaterialRequestKind,
  MaterialRequestStatus,
  MetalKind,
  Prisma,
  ProductionStage,
  RoleCode,
} from '@prisma/client';
import { userHasRole } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { InventoryService } from '../inventory/inventory.service';
import { dbTable } from '../prisma/database-url';
import { PrismaService } from '../prisma/prisma.service';
import { decStr } from '../util/money';
import { ACTIVITY, logActivity } from './activity-log';
import {
  HandoverMaterialDto,
  IssueMaterialRequestDto,
  MaterialRequestDto,
  RejectMaterialRequestDto,
} from './dto/production-order.dto';
import {
  actorName,
  decimalOrNull,
  detailInclude,
  materialRequestMaterial,
  normalizeCode,
  type OrderDetail,
  requireSubTicket,
  STAGE_LABEL,
  subTicketCode,
  toDetail,
  toMaterialRequest,
} from './order-detail';

const BTP_WAREHOUSE_CODE = 'btp-cho-vao-da';
const NVL_WAREHOUSE_CODE = 'nvl-chinh';
/** Kho thợ được xin xuất: kho NVL chính và kho BTP. */
const REQUEST_WAREHOUSES = [NVL_WAREHOUSE_CODE, BTP_WAREHOUSE_CODE];

/**
 * Kho xuất theo khâu (người dùng chốt 2026-09-25): Nguội lấy phôi ở kho BTP, Vào đá lấy ở kho
 * NVL chính — hai khâu này bắt buộc xuất lúc giao. Khắc / Bóng / Xi không xuất kho, chỉ chuyển
 * hàng từ khâu trước.
 */
const STAGE_WAREHOUSES: Record<ProductionStage, string[]> = {
  [ProductionStage.FILING]: [BTP_WAREHOUSE_CODE],
  [ProductionStage.STONE_SETTING]: [NVL_WAREHOUSE_CODE],
  [ProductionStage.ENGRAVING]: [],
  [ProductionStage.POLISHING]: [],
  [ProductionStage.PLATING]: [],
};

const WAREHOUSE_LABEL: Record<string, string> = {
  [BTP_WAREHOUSE_CODE]: 'kho BTP',
  [NVL_WAREHOUSE_CODE]: 'kho NVL chính',
};

/** Chặn mã nằm ngoài kho của khâu. */
function assertStageWarehouse(stage: ProductionStage, warehouseCode: string) {
  const allowed = STAGE_WAREHOUSES[stage];
  if (allowed.length === 0) {
    throw new BadRequestException(
      `Khâu ${STAGE_LABEL[stage]} không xuất kho — chỉ chuyển hàng từ khâu trước`,
    );
  }
  if (!allowed.includes(warehouseCode)) {
    throw new BadRequestException(
      `Khâu ${STAGE_LABEL[stage]} chỉ lấy NVL ở ${allowed.map((code) => WAREHOUSE_LABEL[code]).join(', ')}`,
    );
  }
}

const STONE_UNITS = new Set(['viên', 'vien', 'ct']);
const COUNT_UNITS = new Set(['viên', 'vien']);
const GRAM_UNITS = new Set(['g', 'gr', 'gram', 'grams', 'gam']);
const METALS: MetalKind[] = [
  MetalKind.SILVER,
  MetalKind.GOLD,
  MetalKind.ALLOY,
  MetalKind.COPPER,
];

const LIST_LIMIT = 200;

/** Lần giao khâu mà NVL được xuất vào — chỉ cần id, khâu và phiếu. */
type HandoverEntry = {
  id: string;
  stage: ProductionStage;
  subTicketId: string | null;
};

/** Ngày hôm nay theo giờ Việt Nam — ngày trên phiếu xuất. */
function todayVn() {
  const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return new Date(`${vn.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

const unitKey = (name: string) => name.trim().toLowerCase();

/**
 * Loại gợi ý cho mã NVL. Dữ liệu kho hiện gắn cả đá là SILVER nên đơn vị đếm (viên / ct) được
 * ưu tiên hơn `metalKind`; người duyệt vẫn đổi được lúc xuất.
 */
function suggestKind(material: {
  metalKind: MetalKind | null;
  unit: { name: string };
  warehouse?: { code: string };
}): MaterialRequestKind {
  // Phôi BTP là bạc — tính gram để vào bạc vào khâu.
  if (material.warehouse?.code === BTP_WAREHOUSE_CODE) {
    return MaterialRequestKind.METAL;
  }
  const unit = unitKey(material.unit.name);
  if (material.metalKind === MetalKind.STONE || STONE_UNITS.has(unit)) {
    return MaterialRequestKind.STONE;
  }
  if (
    GRAM_UNITS.has(unit) ||
    (material.metalKind && METALS.includes(material.metalKind))
  ) {
    return MaterialRequestKind.METAL;
  }
  return MaterialRequestKind.OTHER;
}

function isAdmin(actor: AuthUserPayload) {
  return userHasRole(actor.roleCode, actor.extraRoles ?? [], RoleCode.ADMIN);
}

const listInclude = {
  ...materialRequestMaterial(),
  order: { select: { code: true, description: true } },
  subTicket: { select: { no: true } },
  stageEntry: { select: { stage: true, craftsmanName: true } },
} satisfies Prisma.ProductionMaterialRequestInclude;

/**
 * Yêu cầu xuất NVL của thợ trong lúc làm khâu — xuất đến đâu làm đến đó.
 *
 * Thợ đang giữ khâu tạo yêu cầu (mã + số lượng). Kho / người giao cân rồi bấm Xuất: lúc đó mới
 * tạo phiếu xuất gắn mã đơn, trừ tồn, và phần xuất cộng vào đầu vào của khâu khi tính hao hụt.
 * Người duyệt không được là chính thợ (trừ admin) — giống bước xác nhận giao.
 */
@Injectable()
export class ProductionMaterialRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /** Thợ xin xuất NVL cho phiếu mình đang làm. `no` null = phiếu mẹ (đơn chưa chia). */
  async create(
    code: string,
    no: number | null,
    dto: MaterialRequestDto,
    actor: AuthUserPayload,
  ) {
    const material = await this.requestable(dto.materialId);
    const qty = positive(dto.qty, 'Số lượng xin xuất phải lớn hơn 0');
    return this.mutate(code, async (tx, order) => {
      const { entry, label } = openEntryOf(order, no);
      if (entry.submittedAt) {
        throw new BadRequestException(
          `Phiếu ${label} đã báo làm xong khâu ${STAGE_LABEL[entry.stage]} — gỡ báo xong trước nếu cần xin thêm NVL`,
        );
      }
      if (entry.craftsmanUserId !== actor.id && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Chỉ thợ đang giữ khâu này mới xin xuất NVL được',
        );
      }
      assertStageWarehouse(entry.stage, material.warehouse.code);
      const kind = suggestKind(material);
      const created = await tx.productionMaterialRequest.create({
        data: {
          orderId: order.id,
          subTicketId: entry.subTicketId,
          stageEntryId: entry.id,
          materialId: material.id,
          kind,
          requestedQty: qty,
          note: dto.note?.trim() || null,
          requestedByUserId: actor.id,
          requestedByName: actorName(actor),
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.MATERIAL_REQUEST, {
        orderCode: order.code,
        subTicketNo: no,
        stage: entry.stage,
        after: {
          requestId: created.id,
          sku: material.sku ?? material.name,
          name: material.name,
          qty,
          unit: material.unit.name,
        },
        note: dto.note,
      });
    });
  }

  /** Thợ huỷ yêu cầu chưa được xuất. */
  async cancel(id: string, actor: AuthUserPayload) {
    const found = await this.requireRequest(id);
    return this.mutate(found.order.code, async (tx, order) => {
      const request = pendingOf(order, id);
      if (request.requestedByUserId !== actor.id && !isAdmin(actor)) {
        throw new ForbiddenException('Chỉ người xin mới huỷ được yêu cầu này');
      }
      await tx.productionMaterialRequest.update({
        where: { id },
        data: {
          status: MaterialRequestStatus.CANCELLED,
          handledByUserId: actor.id,
          handledByName: actorName(actor),
          handledAt: new Date(),
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.MATERIAL_CANCEL, {
        orderCode: order.code,
        subTicketNo: ticketNoOf(order, request.subTicketId),
        stage: stageOf(order, request.stageEntryId),
        before: requestLog(request),
      });
    });
  }

  /** Kho / người giao cân và xuất: tạo phiếu xuất gắn mã đơn, trừ tồn. */
  async issue(
    id: string,
    dto: IssueMaterialRequestDto,
    actor: AuthUserPayload,
  ) {
    const found = await this.requireRequest(id);
    const qty = positive(dto.qty, 'Số lượng xuất phải lớn hơn 0');
    const detail = await this.mutate(found.order.code, async (tx, order) => {
      const request = pendingOf(order, id);
      const entry = order.stages.find(
        (item) => item.id === request.stageEntryId,
      );
      if (!entry || entry.returnedAt) {
        throw new BadRequestException(
          'KCS đã nhận lại khâu này — không xuất thêm vào khâu đã đóng được',
        );
      }
      const owner = [request.requestedByUserId, entry.craftsmanUserId];
      if (owner.includes(actor.id) && !isAdmin(actor)) {
        throw new ForbiddenException(
          'Thợ không tự duyệt xuất cho mình — nhờ kho / người giao cân và xuất',
        );
      }
      const issued = await this.issueStock(tx, order, entry, actor, {
        materialId: request.materialId,
        kind: dto.kind,
        qty,
        weight: decimalOrNull(dto.weight),
        stoneCount: dto.stoneCount ?? null,
        note: `thợ ${request.requestedByName} xin`,
      });
      await tx.productionMaterialRequest.update({
        where: { id },
        data: {
          status: MaterialRequestStatus.ISSUED,
          kind: dto.kind,
          issuedQty: qty,
          issuedWeight: issued.weight,
          issuedStoneCount: issued.stoneCount,
          outboundId: issued.outboundId,
          handledByUserId: actor.id,
          handledByName: actorName(actor),
          handledAt: new Date(),
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.MATERIAL_ISSUE, {
        orderCode: order.code,
        subTicketNo: ticketNoOf(order, request.subTicketId),
        stage: entry.stage,
        before: requestLog(request),
        after: {
          kind: dto.kind,
          qty,
          unit: request.material.unit.name,
          weight: issued.weight,
          stoneCount: issued.stoneCount,
        },
      });
    });
    this.bustStock(found.material.warehouse.code);
    return detail;
  }

  /**
   * Xuất kho ngay lúc giao khâu: người lên đơn / admin chọn NVL cho thợ. Mỗi dòng thành một
   * phiếu xuất gắn mã đơn và một dòng NVL đã xuất của khâu (`atHandover`). Chạy trong
   * transaction giao khâu — thiếu tồn một dòng thì cả lần giao không thực hiện. Trả về mã kho
   * đã động tới để chỗ gọi làm mới cache tồn sau khi commit.
   */
  async issueAtHandover(
    tx: Prisma.TransactionClient,
    order: OrderDetail,
    entry: HandoverEntry,
    lines: readonly HandoverMaterialDto[],
    actor: AuthUserPayload,
  ) {
    if (STAGE_WAREHOUSES[entry.stage].length > 0 && lines.length === 0) {
      throw new BadRequestException(
        `Khâu ${STAGE_LABEL[entry.stage]} phải chọn NVL xuất ở ${STAGE_WAREHOUSES[entry.stage].map((code) => WAREHOUSE_LABEL[code]).join(', ')} cho thợ`,
      );
    }
    const warehouses = new Set<string>();
    for (const line of lines) {
      const qty = positive(line.qty, 'Số lượng xuất phải lớn hơn 0');
      const issued = await this.issueStock(tx, order, entry, actor, {
        materialId: line.materialId,
        kind: line.kind,
        qty,
        weight: decimalOrNull(line.weight),
        stoneCount: line.stoneCount ?? null,
        note: 'xuất lúc giao khâu',
      });
      warehouses.add(issued.warehouseCode);
      await tx.productionMaterialRequest.create({
        data: {
          orderId: order.id,
          subTicketId: entry.subTicketId,
          stageEntryId: entry.id,
          materialId: line.materialId,
          status: MaterialRequestStatus.ISSUED,
          kind: line.kind,
          atHandover: true,
          requestedQty: qty,
          requestedByUserId: actor.id,
          requestedByName: actorName(actor),
          issuedQty: qty,
          issuedWeight: issued.weight,
          issuedStoneCount: issued.stoneCount,
          outboundId: issued.outboundId,
          handledByUserId: actor.id,
          handledByName: actorName(actor),
          handledAt: new Date(),
        },
      });
    }
    return [...warehouses];
  }

  bustStock(warehouseCode: string) {
    if (warehouseCode === BTP_WAREHOUSE_CODE) {
      this.inventory.bustBtpStock();
    } else {
      this.inventory.bustNvlStock();
    }
  }

  /** Kiểm tra một dòng xuất theo khâu và loại, rồi tạo phiếu xuất FIFO gắn mã đơn. */
  private async issueStock(
    tx: Prisma.TransactionClient,
    order: OrderDetail,
    entry: HandoverEntry,
    actor: AuthUserPayload,
    line: {
      materialId: string;
      kind: MaterialRequestKind;
      qty: Prisma.Decimal;
      weight: Prisma.Decimal | null;
      stoneCount: number | null;
      note: string;
    },
  ) {
    if (
      line.kind === MaterialRequestKind.STONE &&
      entry.stage !== ProductionStage.STONE_SETTING
    ) {
      throw new BadRequestException(
        `Đá chỉ xuất vào khâu ${STAGE_LABEL[ProductionStage.STONE_SETTING]} — khâu đá gắn và KCS đếm lại`,
      );
    }
    if (
      line.kind === MaterialRequestKind.METAL &&
      (!line.weight || line.weight.lte(0))
    ) {
      throw new BadRequestException(
        'Bạc / kim loại phải cân TL xuất (g) — số này vào đầu vào khâu để tính hao hụt',
      );
    }
    const material = await tx.material.findFirst({
      where: {
        id: line.materialId,
        isActive: true,
        warehouse: { code: { in: REQUEST_WAREHOUSES } },
      },
      select: {
        id: true,
        name: true,
        sku: true,
        warehouseId: true,
        unit: { select: { id: true, name: true } },
        warehouse: { select: { code: true } },
      },
    });
    if (!material) {
      throw new BadRequestException(
        'Không tìm thấy mã trong kho NVL chính hoặc kho BTP',
      );
    }
    assertStageWarehouse(entry.stage, material.warehouse.code);
    let stoneCount: number | null = null;
    if (line.kind === MaterialRequestKind.STONE) {
      if (line.stoneCount != null) {
        stoneCount = line.stoneCount;
      } else if (
        COUNT_UNITS.has(unitKey(material.unit.name)) &&
        line.qty.isInteger()
      ) {
        stoneCount = line.qty.toNumber();
      } else {
        throw new BadRequestException(
          `${material.name} tính theo ${material.unit.name} — nhập số viên đá xuất để còn đối chiếu đá mất`,
        );
      }
    }
    const no = ticketNoOf(order, entry.subTicketId);
    const label = no != null ? subTicketCode(order.code, no) : order.code;
    await tx.$executeRaw`SELECT set_config('lock_timeout', '2000', true)`;
    const outbound = await this.inventory.issueStockForOrder(tx, {
      orderId: order.id,
      orderCode: order.code,
      material,
      qty: line.qty,
      issuedAt: todayVn(),
      issuedBy: actorName(actor),
      note: `Xuất cho phiếu ${label} · khâu ${STAGE_LABEL[entry.stage]} (${line.note})`,
    });
    return {
      outboundId: outbound?.id ?? null,
      weight: line.weight,
      stoneCount,
      warehouseCode: material.warehouse.code,
    };
  }

  async reject(
    id: string,
    dto: RejectMaterialRequestDto,
    actor: AuthUserPayload,
  ) {
    const found = await this.requireRequest(id);
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('Nhập lý do không xuất');
    return this.mutate(found.order.code, async (tx, order) => {
      const request = pendingOf(order, id);
      await tx.productionMaterialRequest.update({
        where: { id },
        data: {
          status: MaterialRequestStatus.REJECTED,
          rejectReason: reason,
          handledByUserId: actor.id,
          handledByName: actorName(actor),
          handledAt: new Date(),
        },
      });
      await logActivity(tx, order.id, actor, ACTIVITY.MATERIAL_REJECT, {
        orderCode: order.code,
        subTicketNo: ticketNoOf(order, request.subTicketId),
        stage: stageOf(order, request.stageEntryId),
        before: requestLog(request),
        note: reason,
      });
    });
  }

  /** Hàng chờ của kho: yêu cầu theo trạng thái (mặc định chờ xuất), cũ nhất trước. */
  async list(status: MaterialRequestStatus = MaterialRequestStatus.PENDING) {
    const pending = status === MaterialRequestStatus.PENDING;
    const rows = await this.prisma.productionMaterialRequest.findMany({
      where: { status },
      include: {
        ...listInclude,
        material: {
          select: {
            ...listInclude.material.select,
            metalKind: true,
            balance: { select: { qty: true } },
          },
        },
      },
      orderBy: { requestedAt: pending ? 'asc' : 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map((row) => ({
      ...toMaterialRequest(
        row,
        row.order.code,
        row.subTicket?.no ?? null,
        row.stageEntry.stage,
      ),
      orderDescription: row.order.description,
      craftsmanName: row.stageEntry.craftsmanName,
      suggestedKind: suggestKind(row.material),
      stockQty: row.material.balance ? decStr(row.material.balance.qty) : '0',
    }));
  }

  private async requestable(materialId: string) {
    const material = await this.prisma.material.findFirst({
      where: {
        id: materialId,
        isActive: true,
        warehouse: { code: { in: REQUEST_WAREHOUSES } },
      },
      select: {
        id: true,
        name: true,
        sku: true,
        metalKind: true,
        unit: { select: { name: true } },
        warehouse: { select: { code: true } },
      },
    });
    if (!material) {
      throw new BadRequestException(
        'Không tìm thấy mã trong kho NVL chính hoặc kho BTP',
      );
    }
    return material;
  }

  private async requireRequest(id: string) {
    const found = await this.prisma.productionMaterialRequest.findUnique({
      where: { id },
      select: {
        order: { select: { code: true } },
        material: { select: { warehouse: { select: { code: true } } } },
      },
    });
    if (!found) throw new NotFoundException('Không tìm thấy yêu cầu xuất NVL');
    return found;
  }

  /** Khoá dòng đơn rồi đọc lại, giống các thao tác phiếu con khác. */
  private async mutate(
    code: string,
    apply: (tx: Prisma.TransactionClient, order: OrderDetail) => Promise<void>,
  ) {
    const found = await this.prisma.productionOrder.findUnique({
      where: { code: normalizeCode(code) },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Không tìm thấy đơn sản xuất');
    await this.prisma.runTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ${dbTable('production_orders')} WHERE id = ${found.id}::uuid FOR UPDATE`;
      const order = await tx.productionOrder.findUniqueOrThrow({
        where: { id: found.id },
        include: detailInclude,
      });
      await apply(tx, order);
      await tx.productionOrder.update({
        where: { id: found.id },
        data: { dataChangedAt: new Date() },
      });
    });
    return toDetail(
      await this.prisma.productionOrder.findUniqueOrThrow({
        where: { id: found.id },
        include: detailInclude,
      }),
    );
  }
}

function positive(value: string, message: string) {
  const qty = new Prisma.Decimal(value);
  if (qty.lte(0)) throw new BadRequestException(message);
  return qty;
}

/** Khâu đang làm (chưa KCS nhận lại) của phiếu con / phiếu mẹ. */
function openEntryOf(order: OrderDetail, no: number | null) {
  if (no == null) {
    if (order.subTickets.length > 0) {
      throw new BadRequestException(
        'Đơn đã chia phiếu con — xin xuất trên phiếu con của mình',
      );
    }
    const entry = order.stages.find(
      (item) => !item.subTicketId && !item.returnedAt,
    );
    if (!entry) {
      throw new BadRequestException(
        `Phiếu ${order.code} chưa có khâu nào đang làm — nhận việc và được giao khâu rồi mới xin xuất NVL`,
      );
    }
    return { entry, label: order.code };
  }
  const ticket = requireSubTicket(order, no);
  const label = subTicketCode(order.code, ticket.no);
  if (ticket.outcome) {
    throw new BadRequestException(`Phiếu ${label} đã chốt kết cục`);
  }
  const entry = order.stages.find(
    (item) => item.subTicketId === ticket.id && !item.returnedAt,
  );
  if (!entry) {
    throw new BadRequestException(
      `Phiếu ${label} chưa có khâu nào đang làm — nhận việc và được giao khâu rồi mới xin xuất NVL`,
    );
  }
  return { entry, label };
}

function pendingOf(order: OrderDetail, id: string) {
  const request = order.materialRequests.find((item) => item.id === id);
  if (!request) throw new NotFoundException('Không tìm thấy yêu cầu xuất NVL');
  if (request.status !== MaterialRequestStatus.PENDING) {
    throw new BadRequestException('Yêu cầu này đã được xử lý');
  }
  return request;
}

function ticketNoOf(order: OrderDetail, subTicketId: string | null) {
  if (!subTicketId) return null;
  return (
    order.subTickets.find((ticket) => ticket.id === subTicketId)?.no ?? null
  );
}

function stageOf(order: OrderDetail, stageEntryId: string) {
  return order.stages.find((entry) => entry.id === stageEntryId)?.stage ?? null;
}

function requestLog(request: OrderDetail['materialRequests'][number]) {
  return {
    requestId: request.id,
    sku: request.material.sku ?? request.material.name,
    name: request.material.name,
    qty: request.requestedQty,
    unit: request.material.unit.name,
    requestedByName: request.requestedByName,
  };
}
