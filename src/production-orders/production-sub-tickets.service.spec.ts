import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, ProductionStage, RoleCode } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { ProductionSubTicketsService } from './production-sub-tickets.service';
import { Permission } from '../auth/permissions';
import {
  orderTicketState,
  subTicketState,
  type OrderDetail,
  type SubTicket,
} from './order-detail';
import type { AssignOrderDto } from './dto/production-order.dto';
import type { ProductionMaterialRequestsService } from './production-material-requests.service';

const assignedAt = new Date('2026-10-07T08:00:00Z');
const receivedAt = new Date('2026-10-07T08:05:00Z');
const actor = (
  id: string,
  roleCode: RoleCode = RoleCode.USER,
): AuthUserPayload => ({
  id,
  roleCode,
  username: id,
  fullName: id,
  email: null,
  extraRoles: [],
  allowedScreens: [],
  department: null,
});
const manager = actor('creator');
const worker = actor('worker', RoleCode.WORKER);
const admin = actor('admin', RoleCode.ADMIN);
const stonePhoto = {
  url: 'https://res.cloudinary.com/demo/image/upload/enshido/stone.jpg',
  publicId: 'enshido/stone',
};

const assignment: AssignOrderDto = {
  stage: ProductionStage.FILING,
  craftsmanUserId: worker.id,
  handedQty: 4,
  materials: [],
};

function makeOrder(over: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: 'order',
    code: 'A010',
    status: 'WAIT_FILING',
    source: 'NVL',
    qty: 10,
    createdByUserId: manager.id,
    cutAt: assignedAt,
    blankMaterialId: 'cut-btp',
    blankQty: 10,
    blankWeight: new Prisma.Decimal(20),
    castingCutLines: [],
    subTickets: [],
    stages: [],
    materialRequests: [],
    bomLines: [],
    receipt: null,
    stoneCount: 20,
    stoneSkipped: false,
    pendingStage: null,
    pendingAt: null,
    claimedByUserId: null,
    pendingHandover: null,
    ...over,
  } as OrderDetail;
}
function makeTicket(
  no: number,
  qty: number,
  over: Partial<SubTicket> = {},
): SubTicket {
  return {
    id: `t${no}`,
    no,
    qty,
    pendingStage: null,
    claimedByUserId: null,
    outcome: null,
    note: null,
    ...over,
  } as SubTicket;
}
function returnedFiling(
  ticketId: string | null = null,
): OrderDetail['stages'][number] {
  return {
    id: 'filing',
    subTicketId: ticketId,
    stage: 'FILING',
    attempt: 1,
    handedQty: 10,
    handedSilverWeight: null,
    handedAt: assignedAt,
    returnedAt: assignedAt,
    submittedAt: assignedAt,
    confirmedAt: assignedAt,
    returnedQty: 10,
    returnedSilverWeight: new Prisma.Decimal(18),
    outputMaterialId: 'filed-btp',
  } as OrderDetail['stages'][number];
}

/** Substitute only the locked DB boundary; run the service's real validation and mutations. */
function setup(order = makeOrder()) {
  const materials = {
    issueAtHandover: jest
      .fn<
        Promise<string[]>,
        Parameters<ProductionMaterialRequestsService['issueAtHandover']>
      >()
      .mockResolvedValue(['btp-cho-vao-da']),
    bustStock: jest.fn(),
    stoneImages: jest.fn((images?: Array<{ publicId: string }> | null) => {
      if (!images?.length) throw new BadRequestException('thiếu ảnh gói đá');
      return images.map((image, sortOrder) => ({
        url: 'https://res.cloudinary.com/x.jpg',
        width: null,
        height: null,
        ...image,
        sortOrder,
      }));
    }),
    discardImages: jest.fn().mockResolvedValue(undefined),
  };
  const tx = {
    productionOrder: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(
          order,
          data,
          data.pendingHandover === Prisma.DbNull
            ? { pendingHandover: null }
            : {},
        );
        return Promise.resolve(order);
      }),
    },
    productionSubTicket: {
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const ticket = order.subTickets.find((item) => item.id === where.id)!;
          Object.assign(ticket, data);
          return Promise.resolve(ticket);
        },
      ),
    },
    productionStageEntry: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const entry = {
          id: `entry-${order.stages.length}`,
          subTicketId: null,
          returnedAt: null,
          submittedAt: null,
          ...data,
        } as OrderDetail['stages'][number];
        order.stages.push(entry);
        return Promise.resolve(entry);
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const entry = order.stages.find((item) => item.id === where.id)!;
          Object.assign(entry, data);
          return Promise.resolve(entry);
        },
      ),
    },
    user: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          ...actor(
            where.id,
            where.id === worker.id ? RoleCode.WORKER : RoleCode.USER,
          ),
          workerStages: ['FILING', 'STONE_SETTING'],
        }),
      ),
    },
    productionStoneHold: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    productionActivityLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new ProductionSubTicketsService(
    {} as never,
    materials as never,
    {} as never,
  );
  const boundary = service as unknown as {
    mutate: (
      code: string,
      apply: (
        tx: Prisma.TransactionClient,
        order: OrderDetail,
      ) => Promise<void>,
    ) => Promise<OrderDetail>;
  };
  jest.spyOn(boundary, 'mutate').mockImplementation(async (_code, apply) => {
    await apply(tx as unknown as Prisma.TransactionClient, order);
    return order;
  });
  return { service, order, tx, materials };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(assignedAt);
});
afterEach(() => jest.useRealTimers());

describe('phiếu mẹ: giao → nhận hàng → xuất kho → nộp QC', () => {
  it('tự gắn đúng phôi cắt khi form không gửi dòng BTP và chưa trừ kho lúc chỉ định', async () => {
    const { service, order, materials } = setup();
    await service.assignOrder(order.code, assignment, manager);
    expect(orderTicketState(order, order.stages).state).toBe('CLAIMED');
    expect(order.status).toBe('WAIT_FILING');
    expect(order.pendingHandover).toMatchObject({
      handedQty: 4,
      handedSilverWeight: null,
      handedByUserId: manager.id,
      materials: [
        { materialId: 'cut-btp', kind: 'METAL', qty: '4', weight: '8' },
      ],
    });
    expect(materials.issueAtHandover).not.toHaveBeenCalled();
  });

  it('lúc thợ nhận mới ghi thời gian giao, chuyển Đang nguội và xuất BTP một lần', async () => {
    const { service, order, tx, materials } = setup();
    await service.assignOrder(order.code, assignment, manager);
    jest.setSystemTime(receivedAt);
    await service.acceptOrder(order.code, worker);
    expect(orderTicketState(order, order.stages).state).toBe('WORKING');
    expect(order.status).toBe('FILING');
    expect(order.pendingHandover).toBeNull();
    expect(tx.productionStageEntry.create.mock.calls[0][0].data).toMatchObject({
      handedAt: receivedAt,
      handedQty: 4,
      handedSilverWeight: null,
      handedByUserId: manager.id,
      craftsmanUserId: worker.id,
    });
    expect(materials.issueAtHandover).toHaveBeenCalledWith(
      tx,
      order,
      order.stages[0],
      [
        expect.objectContaining({
          materialId: 'cut-btp',
          qty: '4',
          weight: '8',
        }),
      ],
      expect.objectContaining({ id: manager.id }),
    );
    await expect(
      service.acceptOrder(order.code, worker),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(materials.issueAtHandover).toHaveBeenCalledTimes(1);
    expect(materials.bustStock).toHaveBeenCalledWith('btp-cho-vao-da');
    await service.submitOrder(order.code, worker);
    expect(orderTicketState(order, order.stages).state).toBe('SUBMITTED');
  });

  it('không cho người khác hoặc admin nhận thay thợ được giao', async () => {
    const { service, order, materials } = setup();
    await service.assignOrder(order.code, assignment, manager);
    await expect(service.acceptOrder(order.code, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(materials.issueAtHandover).not.toHaveBeenCalled();
  });

  it('không cho người khác nộp QC thay thợ', async () => {
    const { service, order } = setup();
    await service.assignOrder(order.code, assignment, manager);
    await service.acceptOrder(order.code, worker);
    await expect(service.submitOrder(order.code, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('huỷ giao xoá toàn bộ thông tin chờ và không xuất kho', async () => {
    const { service, order, materials } = setup();
    await service.assignOrder(order.code, assignment, manager);
    await service.cancelOrderPending(order.code, manager);
    expect(orderTicketState(order, order.stages).state).toBe('IDLE');
    expect(order.pendingHandover).toBeNull();
    expect(materials.issueAtHandover).not.toHaveBeenCalled();
  });

  it('thợ trả lượt nhận thì người giao phải giao lại từ đầu', async () => {
    const { service, order } = setup();
    await service.assignOrder(order.code, assignment, manager);
    await service.unclaimOrder(order.code, worker);
    expect(order.pendingStage).toBeNull();
    expect(order.pendingHandover).toBeNull();
    await expect(
      service.acceptOrder(order.code, worker),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('không cho giao trùng khi đã chỉ định thợ', async () => {
    const { service, order } = setup();
    await service.assignOrder(order.code, assignment, manager);
    await expect(
      service.assignOrder(order.code, assignment, manager),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('chặn số giao vượt số phôi còn lại', async () => {
    const { service, order } = setup(makeOrder({ blankQty: 3 }));
    await expect(
      service.assignOrder(order.code, assignment, manager),
    ).rejects.toThrow('chỉ còn 3');
  });

  it('chia gram theo phôi còn lại, phiếu cuối lấy hết phần dư', async () => {
    const order = makeOrder({
      blankQty: 3,
      blankWeight: new Prisma.Decimal(1),
    });
    const { service } = setup(order);
    await service.assignOrder(
      order.code,
      { ...assignment, handedQty: 1 },
      manager,
    );
    expect(order.pendingHandover).toMatchObject({
      materials: [{ weight: '0.3333' }],
    });
    await service.cancelOrderPending(order.code, manager);
    order.materialRequests = [
      {
        status: 'ISSUED',
        materialId: 'cut-btp',
        issuedQty: new Prisma.Decimal(1),
        issuedWeight: new Prisma.Decimal('0.3333'),
      },
    ] as OrderDetail['materialRequests'];
    await service.assignOrder(
      order.code,
      { ...assignment, handedQty: 2 },
      manager,
    );
    expect(order.pendingHandover).toMatchObject({
      materials: [{ qty: '2', weight: '0.6667' }],
    });
  });

  it('đơn cũ thiếu mã phôi dùng BTP đã chọn thủ công', async () => {
    const { service, order } = setup(
      makeOrder({ blankMaterialId: null, blankQty: null, blankWeight: null }),
    );
    await service.assignOrder(
      order.code,
      {
        ...assignment,
        materials: [
          { materialId: 'manual-btp', kind: 'METAL', qty: '4', weight: '8' },
        ],
      },
      manager,
    );
    expect(order.pendingHandover).toMatchObject({
      materials: [{ materialId: 'manual-btp' }],
    });
  });

  it('phiếu theo luồng cũ vẫn xác nhận giao được khi chưa có pendingHandover', async () => {
    const { service, order } = setup(
      makeOrder({ pendingStage: 'FILING', claimedByUserId: worker.id }),
    );
    await service.handoverOrder(
      order.code,
      {
        handedQty: 4,
        materials: [
          { materialId: 'cut-btp', kind: 'METAL', qty: '4', weight: '8' },
        ],
      },
      manager,
    );
    expect(order.status).toBe('FILING');
  });

  it('phiếu đã lưu giao phải do thợ nhận, không cho người giao xác nhận tay', async () => {
    const { service, order } = setup();
    await service.assignOrder(order.code, assignment, manager);
    await expect(
      service.handoverOrder(order.code, { handedQty: 4 }, manager),
    ).rejects.toThrow('không xác nhận giao tay');
  });

  it('Vào đá giữ riêng bạc chuyển tiếp và đá xuất, chuyển Đang vào đá khi nhận', async () => {
    const { service, order, materials } = setup(
      makeOrder({ status: 'WAIT_STONE', stages: [returnedFiling()] }),
    );
    await service.assignOrder(
      order.code,
      {
        ...assignment,
        stage: 'STONE_SETTING',
        handedQty: 10,
        handedSilverWeight: '18',
        handedStoneCount: 20,
        materials: [
          {
            materialId: 'stones',
            kind: 'STONE',
            qty: '20',
            weight: '2',
            stoneCount: 20,
            images: [stonePhoto],
          },
        ],
      },
      manager,
    );
    expect(materials.issueAtHandover).not.toHaveBeenCalled();
    await service.acceptOrder(order.code, worker);
    expect(order.status).toBe('STONE_SETTING');
    expect(order.stages[order.stages.length - 1]).toMatchObject({
      handedSilverWeight: new Prisma.Decimal(18),
      handedStoneCount: 20,
    });
    expect(materials.issueAtHandover.mock.calls[0][3]).toEqual([
      expect.objectContaining({
        kind: 'STONE',
        weight: '2',
        images: [expect.objectContaining({ publicId: stonePhoto.publicId })],
      }),
    ]);
  });

  it('Vào đá: dòng đá không có ảnh gói đá thì không giao được', async () => {
    const { service, order } = setup(
      makeOrder({ status: 'WAIT_STONE', stages: [returnedFiling()] }),
    );
    await expect(
      service.assignOrder(
        order.code,
        {
          ...assignment,
          stage: 'STONE_SETTING',
          handedQty: 10,
          handedSilverWeight: '18',
          materials: [
            { materialId: 'stones', kind: 'STONE', qty: '20', weight: '2' },
          ],
        },
        manager,
      ),
    ).rejects.toThrow('thiếu ảnh gói đá');
    expect(order.pendingStage).toBeNull();
  });

  it('huỷ lượt giao Vào đá thì dọn ảnh gói đá đã chụp', async () => {
    const { service, order, materials } = setup(
      makeOrder({ status: 'WAIT_STONE', stages: [returnedFiling()] }),
    );
    await service.assignOrder(
      order.code,
      {
        ...assignment,
        stage: 'STONE_SETTING',
        handedQty: 10,
        handedSilverWeight: '18',
        materials: [
          {
            materialId: 'stones',
            kind: 'STONE',
            qty: '20',
            weight: '2',
            images: [stonePhoto],
          },
        ],
      },
      manager,
    );
    await service.cancelOrderPending(order.code, manager);
    expect(materials.discardImages).toHaveBeenCalledWith([stonePhoto.publicId]);
  });

  it('không cho Vào đá nếu đơn bỏ đá', async () => {
    const { service, order } = setup(makeOrder({ stoneSkipped: true }));
    await expect(
      service.assignOrder(
        order.code,
        { ...assignment, stage: 'STONE_SETTING' },
        manager,
      ),
    ).rejects.toThrow('không có đá');
  });

  it('khâu Khắc vẫn mở để thợ tự nhận', async () => {
    const { service, order } = setup();
    await service.openOrderStage(order.code, { stage: 'ENGRAVING' }, manager);
    expect(orderTicketState(order, order.stages).state).toBe('WAITING');
    expect(order.claimedByUserId).toBeNull();
  });

  it.each(['open', 'cancel', 'assign'])(
    'người không quản lý đơn không được %s',
    async (action) => {
      const { service, order } = setup();
      const outsider = actor('outsider');
      const operation =
        action === 'open'
          ? service.openOrderStage(order.code, { stage: 'ENGRAVING' }, outsider)
          : action === 'cancel'
            ? service.cancelOrderPending(order.code, outsider)
            : service.assignOrder(order.code, assignment, outsider);
      await expect(operation).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('lỗi xuất kho được trả về và không phát thông báo cache đã đổi', async () => {
    const { service, order, materials } = setup();
    await service.assignOrder(order.code, assignment, manager);
    materials.issueAtHandover.mockRejectedValueOnce(
      new BadRequestException('Không đủ tồn'),
    );
    await expect(service.acceptOrder(order.code, worker)).rejects.toThrow(
      'Không đủ tồn',
    );
    expect(materials.bustStock).not.toHaveBeenCalled();
  });
});

describe.each(['parent', 'child'] as const)(
  'quyền chọn thợ cho %s',
  (scope) => {
    function context() {
      return setup(
        makeOrder({
          subTickets: scope === 'child' ? [makeTicket(1, 10)] : [],
        }),
      );
    }

    function assignSelected(
      service: ProductionSubTicketsService,
      order: OrderDetail,
      by = manager,
    ) {
      return scope === 'parent'
        ? service.assignOrder(order.code, assignment, by)
        : service.assign(
            order.code,
            1,
            {
              stage: ProductionStage.FILING,
              craftsmanUserId: worker.id,
            },
            by,
          );
    }

    it.each([RoleCode.ADMIN, RoleCode.WORKER])(
      'tài khoản thường không giao cho admin có role chính %s',
      async (role) => {
        const { service, order, tx } = context();
        tx.user.findFirst.mockResolvedValueOnce({
          ...actor(worker.id, role),
          extraRoles: role === RoleCode.ADMIN ? [] : [RoleCode.ADMIN],
          workerStages: ['FILING'],
        });
        await expect(assignSelected(service, order)).rejects.toThrow(
          'Chỉ admin',
        );
        expect(tx.productionOrder.update).not.toHaveBeenCalled();
        expect(tx.productionSubTicket.update).not.toHaveBeenCalled();
      },
    );

    it('admin được giao cho admin', async () => {
      const { service, order, tx } = context();
      tx.user.findFirst.mockResolvedValueOnce({
        ...actor(worker.id, RoleCode.ADMIN),
        workerStages: [],
      });
      await expect(
        assignSelected(service, order, admin),
      ).resolves.toBeDefined();
    });

    it('không giao cho nhân viên chỉ được gắn khâu nhưng chưa có quyền thợ', async () => {
      const { service, order, tx } = context();
      tx.user.findFirst.mockResolvedValueOnce({
        ...actor(worker.id),
        workerStages: ['FILING'],
      });
      await expect(assignSelected(service, order)).rejects.toThrow(
        'không có quyền thợ',
      );
    });

    it('nhân viên được cấp quyền thợ sản xuất có thể nhận việc', async () => {
      const { service, order, tx } = context();
      tx.user.findFirst.mockResolvedValueOnce({
        ...actor(worker.id),
        allowedScreens: [Permission.PRODUCTION_WORKER],
        workerStages: ['FILING'],
      });
      await expect(assignSelected(service, order)).resolves.toBeDefined();
    });
  },
);

describe.each(['parent', 'child'] as const)(
  'chặn thợ báo lỗi trên %s',
  (scope) => {
    it.each(Object.values(ProductionStage))(
      'chặn báo / bỏ báo lỗi ở %s kể cả thợ có quyền QC',
      async (stage) => {
        const entry = {
          ...returnedFiling(),
          stage,
          subTicketId: scope === 'child' ? 't1' : null,
          returnedAt: null,
          craftsmanUserId: worker.id,
          defectReportedAt: new Date(),
          defectReportedByUserId: worker.id,
        } as OrderDetail['stages'][number];
        const { service, order, tx } = setup(
          makeOrder({
            stages: [entry],
            subTickets: scope === 'child' ? [makeTicket(1, 10)] : [],
          }),
        );
        const by = { ...worker, allowedScreens: [Permission.PRODUCTION_QC] };
        const no = scope === 'child' ? 1 : null;
        await expect(
          service.reportStageDefect(order.code, no, { note: 'Lỗi' }, by),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.clearStageDefect(order.code, no, by),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(tx.productionStageEntry.update).not.toHaveBeenCalled();
      },
    );

    it.each(['qc', 'admin'] as const)(
      '%s được báo lỗi và bỏ báo lỗi',
      async (role) => {
        const entry = {
          ...returnedFiling(),
          returnedAt: null,
          subTicketId: scope === 'child' ? 't1' : null,
        } as OrderDetail['stages'][number];
        const { service, order } = setup(
          makeOrder({
            stages: [entry],
            subTickets: scope === 'child' ? [makeTicket(1, 10)] : [],
          }),
        );
        const by =
          role === 'admin'
            ? admin
            : { ...manager, allowedScreens: [Permission.PRODUCTION_QC] };
        const no = scope === 'child' ? 1 : null;
        await service.reportStageDefect(order.code, no, { note: 'Lỗi' }, by);
        expect(entry.defectReportedAt).toBeInstanceOf(Date);
        await service.clearStageDefect(order.code, no, by);
        expect(entry.defectReportedAt).toBeNull();
      },
    );
  },
);

describe('phiếu con: số lượng và tự xuất BTP', () => {
  it('đổi một phiếu thành 500 thì chia 500 còn lại đều cho 4 phiếu', async () => {
    const { service, order } = setup(
      makeOrder({
        qty: 1000,
        subTickets: [1, 2, 3, 4, 5].map((no) => makeTicket(no, 200)),
      }),
    );
    await service.update(order.code, 1, { qty: 500 }, manager);
    expect(order.subTickets.map((ticket) => ticket.qty)).toEqual([
      500, 125, 125, 125, 125,
    ]);
  });

  it('phần dư chia cho phiếu số nhỏ trước, tổng luôn bằng số đơn', async () => {
    const { service, order } = setup(
      makeOrder({
        subTickets: [makeTicket(3, 3), makeTicket(1, 4), makeTicket(2, 3)],
      }),
    );
    await service.update(order.code, 3, { qty: 5 }, manager);
    expect(order.subTickets.map((ticket) => ticket.qty)).toEqual([5, 3, 2]);
  });

  it('không chia lại khi phiếu khác đã nhận hàng', async () => {
    const { service, order, tx } = setup(
      makeOrder({
        subTickets: [makeTicket(1, 5), makeTicket(2, 5)],
        stages: [returnedFiling('t2')],
      }),
    );
    await expect(
      service.update(order.code, 1, { qty: 6 }, manager),
    ).rejects.toThrow('đã bắt đầu làm');
    expect(tx.productionSubTicket.update).not.toHaveBeenCalled();
  });

  it('không chia lại khi có phiếu đang giữ đá', async () => {
    const { service, order } = setup(
      makeOrder({
        subTickets: [
          makeTicket(1, 5),
          makeTicket(2, 5, { pendingStage: 'STONE_SETTING' }),
        ],
      }),
    );
    await expect(
      service.update(order.code, 1, { qty: 6 }, manager),
    ).rejects.toThrow('giữ đá');
  });

  it('không để phiếu khác có 0 sản phẩm', async () => {
    const { service, order } = setup(
      makeOrder({ subTickets: [makeTicket(1, 5), makeTicket(2, 5)] }),
    );
    await expect(
      service.update(order.code, 1, { qty: 10 }, manager),
    ).rejects.toThrow('tối thiểu 1');
  });

  it('vẫn cho sửa ghi chú mà không chia lại khi các phiếu đã chạy', async () => {
    const { service, order } = setup(
      makeOrder({
        subTickets: [makeTicket(1, 5), makeTicket(2, 5)],
        stages: [returnedFiling('t2')],
      }),
    );
    await service.update(order.code, 1, { qty: 5, note: ' Ghi chú ' }, manager);
    expect(order.subTickets[0]).toMatchObject({ qty: 5, note: 'Ghi chú' });
    expect(order.subTickets[1].qty).toBe(5);
  });

  it('Nguội tự xuất phôi đã cắt khi thợ nhận và chuyển Đang làm', async () => {
    const ticket = makeTicket(1, 4, {
      pendingStage: 'FILING',
      claimedByUserId: worker.id,
      pendingByName: manager.fullName,
    });
    const { service, order, materials } = setup(
      makeOrder({ subTickets: [ticket, makeTicket(2, 6)] }),
    );
    jest.setSystemTime(receivedAt);
    await service.accept(order.code, 1, worker);
    expect(order.status).toBe('FILING');
    expect(subTicketState(ticket, order.stages).state).toBe('WORKING');
    expect(order.stages[0]).toMatchObject({
      handedAt: receivedAt,
      handedSilverWeight: null,
    });
    expect(materials.issueAtHandover.mock.calls[0][3]).toEqual([
      { materialId: 'cut-btp', kind: 'METAL', qty: '4', weight: '8' },
    ]);
  });

  it('Vào đá phải chờ QC và thủ kho xác nhận khâu trước', async () => {
    const previous = { ...returnedFiling('t1'), confirmedAt: null };
    const { service, order, materials } = setup(
      makeOrder({
        subTickets: [
          makeTicket(1, 10, {
            pendingStage: 'STONE_SETTING',
            claimedByUserId: worker.id,
          }),
        ],
        stages: [previous],
      }),
    );
    expect(subTicketState(order.subTickets[0], order.stages).state).toBe(
      'CONFIRMING',
    );
    await expect(service.accept(order.code, 1, worker)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(materials.issueAtHandover).not.toHaveBeenCalled();
  });

  it('Vào đá xuất BTP khâu trước, gắn đá giữ chỗ mà chưa xuất đá', async () => {
    const { service, order, tx, materials } = setup(
      makeOrder({
        subTickets: [
          makeTicket(1, 10, {
            pendingStage: 'STONE_SETTING',
            claimedByUserId: worker.id,
          }),
        ],
        stages: [returnedFiling('t1')],
      }),
    );
    tx.productionStoneHold.findMany.mockResolvedValueOnce([
      { id: 'hold', stoneCount: 20, weight: new Prisma.Decimal(2) },
    ]);
    await service.accept(order.code, 1, worker);
    expect(order.status).toBe('STONE_SETTING');
    expect(order.stages[order.stages.length - 1]).toMatchObject({
      handedSilverWeight: null,
      handedStoneCount: 20,
    });
    expect(materials.issueAtHandover.mock.calls[0][3]).toEqual([
      { materialId: 'filed-btp', kind: 'METAL', qty: '10', weight: '18' },
    ]);
    expect(tx.productionStoneHold.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { stageEntryId: order.stages[order.stages.length - 1].id },
      }),
    );
  });
});
