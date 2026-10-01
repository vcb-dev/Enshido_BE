import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CastingSlipStatus,
  IntakeOrderStatus,
  Prisma,
  ProductionRequestType,
  ProductionSource,
  ProductionStatus as S,
  type ProductionStatus,
} from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { recordEditLog } from '../edit-logs/edit-log';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVITY, logActivity } from '../production-orders/activity-log';
import { actorName } from '../production-orders/order-detail';
import { orderCode } from '../production-orders/production-orders.service';
import { CloudinaryService } from '../uploads/cloudinary.service';
import { decStr } from '../util/money';
import {
  CreateCastingCutDto,
  CutImageDto,
  ListCastingCutsQuery,
} from './dto/casting-cut.dto';

const BTP_WAREHOUSE = 'btp-cho-vao-da';
const NVL_WAREHOUSE = 'nvl-chinh';
/** Mã NVL mặc định nhận phần còn lại của cây khi thủ kho không chọn mã khác. */
export const DEFAULT_REST_MATERIAL = 'Bạc thu hồi / đầu cây S925';
/** Đơn cắt được: đơn NVL mới lên hoặc đang Đúc. */
const CUTTABLE: ProductionStatus[] = [S.NEW, S.CASTING];

const cutInclude = {
  castingOrder: { select: { id: true, code: true } },
  castingSlip: { select: { id: true, code: true } },
  restMaterial: { select: { id: true, sku: true, name: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: {
      btpMaterial: { select: { id: true, sku: true, name: true } },
      order: {
        select: {
          id: true,
          code: true,
          status: true,
          model3dCode: true,
          description: true,
          qty: true,
          qtyUnit: true,
          castingSentDate: true,
          intakeOrderId: true,
          intakeOrder: { select: { code: true } },
          images: {
            orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
            take: 1,
            select: { url: true },
          },
          _count: { select: { stages: true, subTickets: true } },
        },
      },
    },
  },
} satisfies Prisma.CastingCutInclude;

type CutRow = Prisma.CastingCutGetPayload<{ include: typeof cutInclude }>;

@Injectable()
export class CastingCutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async list(query: ListCastingCutsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const keyword = query.search?.trim();
    const contains = { contains: keyword, mode: 'insensitive' } as const;
    const where: Prisma.CastingCutWhereInput = keyword
      ? {
          OR: [
            { code: contains },
            { castingOrder: { code: contains } },
            { castingSlip: { code: contains } },
            { lines: { some: { order: { code: contains } } } },
            { lines: { some: { order: { model3dCode: contains } } } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.castingCut.count({ where }),
      this.prisma.castingCut.findMany({
        where,
        orderBy: { seq: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: cutInclude,
      }),
    ]);
    return { items: rows.map(toDetail), total, page, pageSize };
  }

  async detail(code: string) {
    return toDetail(await this.requireCut(code));
  }

  /**
   * Đơn chờ cắt: đơn tạo đã Đúc xong (H) đi trước, sau đó là phiếu sản xuất cũ tạo tay
   * (NVL, chưa cắt cây, chưa giao khâu nào).
   */
  async orderOptions(search?: string) {
    const keyword = search?.trim();
    const contains = { contains: keyword, mode: 'insensitive' } as const;
    const [intakes, rows] = await Promise.all([
      this.prisma.intakeOrder.findMany({
        where: {
          status: IntakeOrderStatus.CAST_DONE,
          ...(keyword
            ? {
                OR: [
                  { code: contains },
                  { sxCode: contains },
                  { productName: contains },
                  { trackingCode: contains },
                  { description: contains },
                ],
              }
            : {}),
        },
        orderBy: { seq: 'desc' },
        take: 50,
        select: {
          id: true,
          code: true,
          sxCode: true,
          status: true,
          productName: true,
          trackingCode: true,
          description: true,
          qty: true,
          images: {
            orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
            take: 1,
            select: { url: true },
          },
          castingSlipLine: {
            select: {
              slip: { select: { code: true, slipDate: true, castTreeWeightGram: true } },
            },
          },
        },
      }),
      this.prisma.productionOrder.findMany({
        where: {
          source: ProductionSource.NVL,
          status: { in: CUTTABLE },
          cutAt: null,
          stages: { none: {} },
          intakeOrderId: null,
          ...(keyword
            ? {
                OR: [
                  { code: contains },
                  { model3dCode: contains },
                  { description: contains },
                ],
              }
            : {}),
        },
        orderBy: { seq: 'desc' },
        take: 50,
        select: {
          id: true,
          code: true,
          status: true,
          model3dCode: true,
          description: true,
          qty: true,
          qtyUnit: true,
          castingSentDate: true,
          images: {
            orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
            take: 1,
            select: { url: true },
          },
        },
      }),
    ]);
    const fromIntake = intakes.map((row) => {
      const slip = row.castingSlipLine?.slip ?? null;
      return {
        kind: 'intake' as const,
        id: row.id,
        code: row.code,
        status: row.status as string,
        model3dCode: row.trackingCode,
        description: [row.productName, row.description]
          .filter(Boolean)
          .join(' — '),
        qty: row.qty,
        qtyUnit: null as string | null,
        castingSentDate: slip ? slip.slipDate.toISOString().slice(0, 10) : null,
        imageUrl: row.images[0]?.url ?? null,
        // Một cây thông = một phiếu đúc: gợi ý TL cây sau đúc thủ kho đã xác nhận ở bước 9.
        castTreeWeight: slip?.castTreeWeightGram ? decStr(slip.castTreeWeightGram) : null,
        castingSlipCode: slip?.code ?? null,
      };
    });
    const fromOrders = rows.map((row) => ({
      kind: 'order' as const,
      id: row.id,
      code: row.code,
      status: row.status as string,
      model3dCode: row.model3dCode,
      description: row.description,
      qty: row.qty,
      qtyUnit: row.qtyUnit,
      castingSentDate: row.castingSentDate
        ? row.castingSentDate.toISOString().slice(0, 10)
        : null,
      imageUrl: row.images[0]?.url ?? null,
      castTreeWeight: null as string | null,
      castingSlipCode: null as string | null,
    }));
    return [...fromIntake, ...fromOrders];
  }

  /** Mã NVL tính gram trên kho NVL chính — chọn loại bạc nhận phần còn lại của cây. */
  async restMaterialOptions() {
    const rows = await this.prisma.material.findMany({
      where: {
        isActive: true,
        warehouse: { code: NVL_WAREHOUSE },
        unit: { code: 'gram' },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, sku: true, name: true },
    });
    return { defaultName: DEFAULT_REST_MATERIAL, items: rows };
  }

  /**
   * Phiếu đúc đã được thủ kho xác nhận Đúc xong và chưa cắt — mỗi phiếu là một cây thông.
   * Kèm các đơn trong lô (còn ở Đúc xong) để form cắt tự điền dòng phôi.
   */
  async castingSlipOptions() {
    const rows = await this.prisma.castingSlip.findMany({
      where: { status: CastingSlipStatus.DONE, cut: null },
      orderBy: { confirmedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        code: true,
        slipDate: true,
        castTreeWeightGram: true,
        startedByName: true,
        orders: {
          orderBy: { sortOrder: 'asc' },
          where: { intake: { status: IntakeOrderStatus.CAST_DONE } },
          select: {
            intake: {
              select: {
                id: true,
                code: true,
                status: true,
                productName: true,
                trackingCode: true,
                description: true,
                qty: true,
                images: {
                  orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
                  take: 1,
                  select: { url: true },
                },
              },
            },
          },
        },
      },
    });
    return rows
      .filter((row) => row.orders.length > 0)
      .map((row) => {
        const slipDate = row.slipDate.toISOString().slice(0, 10);
        const castTreeWeight = row.castTreeWeightGram ? decStr(row.castTreeWeightGram) : null;
        return {
          id: row.id,
          code: row.code,
          slipDate,
          castTreeWeight,
          castByName: row.startedByName,
          orders: row.orders.map(({ intake }) => ({
            kind: 'intake' as const,
            id: intake.id,
            code: intake.code,
            status: intake.status as string,
            model3dCode: intake.trackingCode,
            description: [intake.productName, intake.description].filter(Boolean).join(' — '),
            qty: intake.qty,
            qtyUnit: null as string | null,
            castingSentDate: slipDate,
            imageUrl: intake.images[0]?.url ?? null,
            castTreeWeight,
            castingSlipCode: row.code,
          })),
        };
      });
  }

  async castingOrderOptions() {
    const rows = await this.prisma.castingOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, code: true, moldCount: true, createdAt: true },
    });
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async create(dto: CreateCastingCutDto, actor: AuthUserPayload) {
    for (const line of dto.lines) {
      if (Boolean(line.orderId) === Boolean(line.intakeOrderId)) {
        throw new BadRequestException(
          'Mỗi dòng phải chọn đúng một đơn (phiếu sản xuất hoặc đơn tạo)',
        );
      }
    }
    const lineKeys = dto.lines.map((line) =>
      line.intakeOrderId ? `i:${line.intakeOrderId}` : `o:${line.orderId}`,
    );
    if (new Set(lineKeys).size !== lineKeys.length) {
      throw new BadRequestException(
        'Một đơn chỉ nhận phôi một dòng trên phiếu',
      );
    }
    const cutAt = new Date(dto.cutAt);
    if (cutAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException('Thời gian cắt không được ở tương lai');
    }

    const treeWeight = new Prisma.Decimal(dto.treeWeight);
    const restWeight = new Prisma.Decimal(dto.restWeight);
    if (treeWeight.lte(0)) {
      throw new BadRequestException('Trọng lượng cây thông phải lớn hơn 0');
    }
    const lineWeights = dto.lines.map((line) => {
      const weight = new Prisma.Decimal(line.weight);
      if (weight.lte(0)) {
        throw new BadRequestException('Trọng lượng phôi phải lớn hơn 0');
      }
      return weight;
    });
    const blanks = lineWeights.reduce(
      (sum, weight) => sum.add(weight),
      new Prisma.Decimal(0),
    );
    if (blanks.add(restWeight).gt(treeWeight)) {
      throw new BadRequestException(
        `Tổng phôi (${decStr(blanks)} g) cộng phần còn lại (${decStr(restWeight)} g) vượt trọng lượng cây (${decStr(treeWeight)} g)`,
      );
    }
    if (restWeight.gt(0) && dto.restImages.length === 0) {
      throw new BadRequestException('Chụp ảnh cân phần còn lại của cây');
    }
    this.assertOwnImages([
      ...dto.restImages,
      ...dto.lines.flatMap((line) => line.images),
    ]);

    if (dto.castingOrderId) {
      const found = await this.prisma.castingOrder.findUnique({
        where: { id: dto.castingOrderId },
        select: { id: true },
      });
      if (!found) throw new NotFoundException('Không tìm thấy lệnh đúc');
    }
    if (dto.castingSlipId) {
      const slip = await this.prisma.castingSlip.findUnique({
        where: { id: dto.castingSlipId },
        select: {
          code: true,
          status: true,
          cut: { select: { code: true } },
          orders: { select: { intakeOrderId: true } },
        },
      });
      if (!slip) throw new NotFoundException('Không tìm thấy phiếu đúc');
      if (slip.status !== CastingSlipStatus.DONE) {
        throw new BadRequestException(`Phiếu đúc ${slip.code} chưa được thủ kho xác nhận Đúc xong`);
      }
      if (slip.cut) {
        throw new BadRequestException(`Cây của phiếu đúc ${slip.code} đã cắt ở phiếu ${slip.cut.code}`);
      }
      const inSlip = new Set(slip.orders.map((line) => line.intakeOrderId));
      for (const line of dto.lines) {
        if (!line.intakeOrderId || !inSlip.has(line.intakeOrderId)) {
          throw new BadRequestException(
            `Mọi đơn trên phiếu cắt phải thuộc phiếu đúc ${slip.code}`,
          );
        }
      }
    }

    const orderSelect = {
      id: true,
      code: true,
      source: true,
      status: true,
      model3dCode: true,
      cutAt: true,
      _count: { select: { stages: true } },
    } satisfies Prisma.ProductionOrderSelect;
    const orderIds = dto.lines.flatMap((line) =>
      line.orderId ? [line.orderId] : [],
    );
    const intakeIds = dto.lines.flatMap((line) =>
      line.intakeOrderId ? [line.intakeOrderId] : [],
    );
    const orders = await this.prisma.productionOrder.findMany({
      where: { id: { in: orderIds } },
      select: orderSelect,
    });
    const byId = new Map(orders.map((order) => [order.id, order]));
    for (const id of orderIds) {
      const order = byId.get(id);
      if (!order) throw new NotFoundException('Không tìm thấy đơn sản xuất');
      assertCuttable(order);
    }
    const intakes = await this.prisma.intakeOrder.findMany({
      where: { id: { in: intakeIds } },
      select: {
        id: true,
        code: true,
        status: true,
        requestType: true,
        productName: true,
        qty: true,
        trackingCode: true,
        placedBy: true,
        description: true,
        createdDate: true,
        dueDate: true,
        model3dUrl: true,
        productionOrder: { select: orderSelect },
        castingSlipLine: {
          select: {
            slip: {
              select: { id: true, code: true, slipDate: true, castTreeWeightGram: true },
            },
          },
        },
      },
    });
    const intakeById = new Map(intakes.map((row) => [row.id, row]));
    for (const id of intakeIds) {
      const intake = intakeById.get(id);
      if (!intake) throw new NotFoundException('Không tìm thấy đơn tạo');
      if (intake.status !== IntakeOrderStatus.CAST_DONE) {
        throw new BadRequestException(
          `Đơn ${intake.code} chưa Đúc xong (H) — chỉ cắt cây khi thủ kho đã xác nhận đúc`,
        );
      }
      if (intake.productionOrder) assertCuttable(intake.productionOrder);
    }
    // Cây đem cắt là cây thủ kho đã cân sau đúc (bước 9): TL cắt không vượt TL cây giao sang.
    if (intakeIds.length && intakeIds.length === dto.lines.length) {
      const slips = new Map<string, { code: string; weight: Prisma.Decimal | null }>();
      for (const intake of intakes) {
        const slip = intake.castingSlipLine?.slip;
        if (slip) slips.set(slip.id, { code: slip.code, weight: slip.castTreeWeightGram });
      }
      const weights = [...slips.values()];
      if (weights.length && weights.every((slip) => slip.weight != null)) {
        const cast = weights.reduce(
          (sum, slip) => sum.add(slip.weight!),
          new Prisma.Decimal(0),
        );
        if (treeWeight.gt(cast)) {
          throw new BadRequestException(
            `TL cây (${decStr(treeWeight)} g) vượt TL cây sau đúc đã xác nhận ở phiếu ${weights
              .map((slip) => slip.code)
              .join(', ')} (${decStr(cast)} g)`,
          );
        }
      }
    }

    const cutByName = actorName(actor);
    let created: { id: string; code: string };
    try {
      created = await this.prisma.runTx(async (tx) => {
        const restMaterialId = restWeight.gt(0)
          ? await this.resolveRestMaterial(tx, dto.restMaterialId)
          : null;
        const last = await tx.castingCut.findFirst({
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        const seq = (last?.seq ?? 0) + 1;
        const code = cutCode(seq);
        const cut = await tx.castingCut.create({
          data: {
            seq,
            code,
            castingOrderId: dto.castingOrderId ?? null,
            castingSlipId: dto.castingSlipId ?? null,
            cutAt,
            treeWeight,
            restWeight,
            restMaterialId,
            note: dto.note ?? null,
            cutByUserId: actor.id,
            cutByName,
            images: {
              create: dto.restImages.map((image, index) =>
                imageData(image, index),
              ),
            },
          },
          select: { id: true, code: true },
        });

        for (const [index, line] of dto.lines.entries()) {
          let order: {
            id: string;
            code: string;
            status: ProductionStatus;
            model3dCode: string | null;
          };
          if (line.intakeOrderId) {
            const intake = intakeById.get(line.intakeOrderId)!;
            // Chặn hai phiếu cắt cùng lúc nhận một đơn tạo.
            const moved = await tx.intakeOrder.updateMany({
              where: {
                id: intake.id,
                status: IntakeOrderStatus.CAST_DONE,
              },
              data: { status: IntakeOrderStatus.WAIT_COOLING },
            });
            if (moved.count !== 1) {
              throw new ConflictException(
                `Đơn ${intake.code} vừa được cắt ở phiếu khác — tải lại danh sách đơn`,
              );
            }
            order =
              intake.productionOrder ??
              (await this.createOrderFromIntake(tx, intake, actor));
          } else {
            order = byId.get(line.orderId!)!;
          }
          const weight = lineWeights[index];
          // Chặn hai phiếu cắt cùng lúc nhận một đơn: chỉ đơn chưa cắt mới được ghi mốc.
          const claimed = await tx.productionOrder.updateMany({
            where: {
              id: order.id,
              cutAt: null,
              status: { in: CUTTABLE },
            },
            data: { cutAt, status: S.WAIT_FILING, dataChangedAt: new Date() },
          });
          if (claimed.count !== 1) {
            throw new ConflictException(
              `Đơn ${order.code} vừa được cắt ở phiếu khác — tải lại danh sách đơn`,
            );
          }
          const btpMaterialId = await this.inventory.ensureNamedMaterial(tx, {
            warehouseCode: BTP_WAREHOUSE,
            name: blankName(order),
            unitCode: 'chiec',
          });
          const btpInboundId = await this.inventory.createAutoInbound(tx, {
            materialId: btpMaterialId,
            qty: new Prisma.Decimal(line.qty),
            gramQty: weight,
            receivedAt: cutAt,
            note: `Phôi đơn ${order.code} — phiếu cắt ${code}`,
            enteredBy: cutByName,
            productionOrderId: order.id,
          });
          await tx.castingCutLine.create({
            data: {
              cutId: cut.id,
              orderId: order.id,
              sortOrder: index,
              qty: line.qty,
              weight,
              btpMaterialId,
              btpInboundId,
              prevStatus: order.status,
              images: {
                create: line.images.map((image, imageIndex) => ({
                  cutId: cut.id,
                  ...imageData(image, imageIndex),
                })),
              },
            },
          });
          await tx.productionStatusLog.create({
            data: {
              orderId: order.id,
              fromStatus: order.status,
              toStatus: S.WAIT_FILING,
              note: `Cắt cây ${code}: ${line.qty} phôi, ${decStr(weight)} g — chờ Nguội`,
              changedBy: cutByName,
            },
          });
          await logActivity(tx, order.id, actor, ACTIVITY.ORDER_CUT, {
            orderCode: order.code,
            before: { status: order.status },
            after: {
              status: S.WAIT_FILING,
              cutCode: code,
              qty: line.qty,
              weight,
              cutAt,
            },
          });
        }

        if (restMaterialId) {
          const restInboundId = await this.inventory.createAutoInbound(tx, {
            materialId: restMaterialId,
            qty: restWeight,
            gramQty: restWeight,
            receivedAt: cutAt,
            note: `Phần còn lại cây thông — phiếu cắt ${code}`,
            enteredBy: cutByName,
          });
          await tx.castingCut.update({
            where: { id: cut.id },
            data: { restInboundId },
          });
        }
        return cut;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Mã phiếu cắt vừa bị cấp trùng, lưu lại');
      }
      throw error;
    }
    this.inventory.bustBtpStock();
    this.inventory.bustNvlStock();
    return this.detail(created.code);
  }

  /**
   * Xoá phiếu cắt để sửa sai: hoàn phiếu nhập BTP / NVL và trả các đơn về trạng thái trước
   * khi cắt. Chỉ được khi chưa đơn nào chia phiếu con hay giao khâu Nguội.
   */
  async remove(code: string, reason: string, actor: AuthUserPayload) {
    const cut = await this.requireCut(code);
    for (const line of cut.lines) {
      const { _count: count, code: orderCode } = line.order;
      if (count.stages > 0 || count.subTickets > 0) {
        throw new BadRequestException(
          `Đơn ${orderCode} đã chia phiếu / giao khâu Nguội — không xoá được phiếu cắt`,
        );
      }
    }
    const changedBy = actorName(actor);
    await this.prisma.runTx(async (tx) => {
      await this.inventory.revokeAutoInbounds(
        tx,
        [
          ...cut.lines.map((line) => line.btpInboundId),
          cut.restInboundId,
        ].filter((id): id is string => Boolean(id)),
      );
      const intakeLinked: { orderId: string; intakeOrderId: string }[] = [];
      for (const line of cut.lines) {
        const order = line.order;
        if (order.intakeOrderId) {
          // Phiếu sản xuất do cắt cây sinh ra — xoá hẳn ở cuối, đơn tạo quay về Đúc xong.
          intakeLinked.push({
            orderId: order.id,
            intakeOrderId: order.intakeOrderId,
          });
          continue;
        }
        await tx.productionOrder.update({
          where: { id: order.id },
          data: {
            cutAt: null,
            dataChangedAt: new Date(),
            ...(order.status === S.WAIT_FILING ? { status: line.prevStatus } : {}),
          },
        });
        if (order.status === S.WAIT_FILING) {
          await tx.productionStatusLog.create({
            data: {
              orderId: order.id,
              fromStatus: order.status,
              toStatus: line.prevStatus,
              note: `Xoá phiếu cắt ${cut.code}: ${reason}`,
              changedBy,
            },
          });
        }
        await logActivity(tx, order.id, actor, ACTIVITY.ORDER_UNDO_CUT, {
          orderCode: order.code,
          before: {
            status: order.status,
            cutCode: cut.code,
            qty: line.qty,
            weight: line.weight,
          },
          after: { status: line.prevStatus },
          note: reason,
        });
      }
      await recordEditLog(tx, {
        entityType: 'casting_cut',
        entityId: cut.id,
        reason,
        changedBy,
      });
      await tx.castingCut.delete({ where: { id: cut.id } });
      for (const link of intakeLinked) {
        await tx.productionOrder.delete({ where: { id: link.orderId } });
        await tx.intakeOrder.updateMany({
          where: {
            id: link.intakeOrderId,
            status: IntakeOrderStatus.WAIT_COOLING,
          },
          data: { status: IntakeOrderStatus.CAST_DONE },
        });
      }
    });
    this.inventory.bustBtpStock();
    this.inventory.bustNvlStock();
    await this.cloudinary.destroy(cut.images.map((image) => image.publicId));
    return { success: true };
  }

  async markPrinted(code: string) {
    const cut = await this.requireCut(code);
    await this.prisma.castingCut.update({
      where: { id: cut.id },
      data: { lastPrintedAt: new Date() },
    });
    return { success: true };
  }

  /** Sinh phiếu sản xuất (A001…) từ đơn tạo khi cắt cây — đơn đi tiếp Nguội trên phiếu này. */
  private async createOrderFromIntake(
    tx: Prisma.TransactionClient,
    intake: {
      id: string;
      code: string;
      requestType: ProductionRequestType;
      productName: string;
      qty: number;
      trackingCode: string | null;
      placedBy: string;
      description: string;
      createdDate: Date;
      dueDate: Date | null;
      model3dUrl: string | null;
      castingSlipLine: { slip: { slipDate: Date } } | null;
    },
    actor: AuthUserPayload,
  ) {
    const last = await tx.productionOrder.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    const code = orderCode(seq);
    const changedBy = actorName(actor);
    const description = [intake.productName, intake.description]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' — ');
    const row = await tx.productionOrder.create({
      data: {
        seq,
        code,
        status: S.NEW,
        source: ProductionSource.NVL,
        requestType: intake.requestType,
        qty: intake.qty,
        trackingCode: intake.trackingCode,
        // Phôi trên kho BTP gom theo mã sản phẩm — mã sản phẩm của đơn tạo.
        model3dCode: intake.trackingCode,
        model3dUrl: intake.model3dUrl,
        closedBy: intake.placedBy,
        description,
        receivedDate: intake.createdDate,
        dueDate: intake.dueDate,
        castingSentDate: intake.castingSlipLine?.slip.slipDate ?? null,
        createdBy: changedBy,
        createdByUserId: actor.id,
        intakeOrderId: intake.id,
        statusLogs: {
          create: {
            toStatus: S.NEW,
            changedBy,
            note: `Sinh từ đơn tạo ${intake.code} khi cắt cây thông`,
          },
        },
      },
      select: { id: true, code: true, status: true, model3dCode: true },
    });
    await logActivity(tx, row.id, actor, ACTIVITY.ORDER_CREATE, {
      orderCode: row.code,
      note: `Sinh từ đơn tạo ${intake.code} khi cắt cây thông`,
    });
    return row;
  }

  private async requireCut(code: string) {
    const cut = await this.prisma.castingCut.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: cutInclude,
    });
    if (!cut) throw new NotFoundException(`Không tìm thấy phiếu cắt ${code}`);
    return cut;
  }

  private async resolveRestMaterial(
    tx: Prisma.TransactionClient,
    materialId: string | null | undefined,
  ) {
    if (!materialId) {
      return this.inventory.ensureNamedMaterial(tx, {
        warehouseCode: NVL_WAREHOUSE,
        name: DEFAULT_REST_MATERIAL,
        unitCode: 'gram',
      });
    }
    const material = await tx.material.findFirst({
      where: {
        id: materialId,
        isActive: true,
        warehouse: { code: NVL_WAREHOUSE },
      },
      select: { id: true, unit: { select: { code: true } } },
    });
    if (!material) {
      throw new BadRequestException(
        'Mã NVL nhận phần còn lại không có trên kho NVL chính',
      );
    }
    if (material.unit.code !== 'gram') {
      throw new BadRequestException(
        'Mã NVL nhận phần còn lại phải tính theo gram',
      );
    }
    return material.id;
  }

  private assertOwnImages(images: CutImageDto[]) {
    for (const image of images) {
      const host = new URL(image.url).hostname;
      if (
        host !== 'res.cloudinary.com' ||
        !this.cloudinary.ownsPublicId(image.publicId)
      ) {
        throw new BadRequestException('Ảnh không thuộc kho ảnh của hệ thống');
      }
    }
  }
}

function assertCuttable(order: {
  code: string;
  source: ProductionSource;
  status: ProductionStatus;
  cutAt: Date | null;
  _count: { stages: number };
}) {
  if (order.source !== ProductionSource.NVL) {
    throw new BadRequestException(
      `Đơn ${order.code} là đơn BTP, lấy hàng đúc sẵn — không qua cắt cây`,
    );
  }
  if (order.cutAt) {
    throw new BadRequestException(`Đơn ${order.code} đã cắt cây rồi`);
  }
  if (!CUTTABLE.includes(order.status) || order._count.stages > 0) {
    throw new BadRequestException(
      `Đơn ${order.code} không ở bước chờ cắt cây (Mới / Đúc)`,
    );
  }
}

/** Mã phôi trên kho BTP gom theo mã sản phẩm; đơn chưa có mã sản phẩm thì theo mã đơn. */
function blankName(order: { code: string; model3dCode: string | null }) {
  return `Phôi ${order.model3dCode?.trim() || order.code}`;
}

function cutCode(seq: number) {
  return `CC${String(seq).padStart(4, '0')}`;
}

function imageData(image: CutImageDto, sortOrder: number) {
  return {
    url: image.url,
    publicId: image.publicId,
    width: image.width ?? null,
    height: image.height ?? null,
    sortOrder,
  };
}

function toDetail(cut: CutRow) {
  const zero = new Prisma.Decimal(0);
  const blanks = cut.lines.reduce((sum, line) => sum.add(line.weight), zero);
  const loss = cut.treeWeight.sub(blanks).sub(cut.restWeight);
  const imagesOf = (lineId: string | null) =>
    cut.images
      .filter((image) => image.lineId === lineId)
      .map((image) => ({
        url: image.url,
        publicId: image.publicId,
        width: image.width,
        height: image.height,
      }));
  return {
    id: cut.id,
    code: cut.code,
    castingOrder: cut.castingOrder,
    castingSlip: cut.castingSlip,
    cutAt: cut.cutAt.toISOString(),
    treeWeight: decStr(cut.treeWeight),
    restWeight: decStr(cut.restWeight),
    blankWeight: decStr(blanks),
    lossWeight: decStr(loss),
    restMaterial: cut.restMaterial,
    restImages: imagesOf(null),
    note: cut.note,
    cutByName: cut.cutByName,
    lastPrintedAt: cut.lastPrintedAt?.toISOString() ?? null,
    createdAt: cut.createdAt.toISOString(),
    // Xoá phiếu chỉ được khi chưa đơn nào vào khâu Nguội.
    deletable: cut.lines.every(
      (line) =>
        line.order._count.stages === 0 && line.order._count.subTickets === 0,
    ),
    lines: cut.lines.map((line) => ({
      id: line.id,
      qty: line.qty,
      weight: decStr(line.weight),
      btpMaterial: line.btpMaterial,
      images: imagesOf(line.id),
      order: {
        id: line.order.id,
        code: line.order.code,
        status: line.order.status,
        intakeCode: line.order.intakeOrder?.code ?? null,
        model3dCode: line.order.model3dCode,
        description: line.order.description,
        qty: line.order.qty,
        qtyUnit: line.order.qtyUnit,
        imageUrl: line.order.images[0]?.url ?? null,
      },
    })),
  };
}
