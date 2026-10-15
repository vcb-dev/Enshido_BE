import { BadRequestException } from '@nestjs/common';
import { Prisma, ProductionStatus, RoleCode } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { Permission } from '../auth/permissions';
import { CastingSlipsService } from './casting-slips.service';

const actor: AuthUserPayload = {
  id: 'keeper',
  username: 'keeper',
  email: null,
  fullName: 'Thủ kho',
  roleCode: RoleCode.USER,
  extraRoles: [],
  allowedScreens: [Permission.WAREHOUSE_KEEPER],
  department: null,
};
const image = {
  url: 'https://res.cloudinary.com/demo/image/upload/a.jpg',
  publicId: 'enshido/a',
};

function order(id: string) {
  return {
    id,
    code: `A${id}`,
    intakeCode: `DH${id}`,
    status: ProductionStatus.CAST_DONE,
    cutAt: null,
    productName: 'Nhẫn',
    qty: 2,
    trackingCode: `SP${id}`,
    description: '',
  };
}

function setup(treeWeight: number) {
  const tx = {
    castingSlip: {
      findUnique: jest.fn().mockResolvedValue({
        slipDate: new Date('2026-09-29'),
        status: 'DONE',
        confirmedAt: new Date('2026-10-04'),
        restWeightGram: null,
        castTreeWeightGram: new Prisma.Decimal(treeWeight),
        orders: [{ order: order('1') }, { order: order('2') }],
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    castingSlipOrder: { update: jest.fn().mockResolvedValue({}) },
    productionOrder: {
      updateMany: jest
        .fn()
        .mockImplementation(
          async (args: { where?: { id?: string | { in?: string[] } } }) => ({
            count: Array.isArray(args.where?.id)
              ? 1
              : args.where?.id &&
                  typeof args.where.id === 'object' &&
                  args.where.id.in
                ? args.where.id.in.length
                : 1,
          }),
        ),
      create: jest.fn(),
      update: jest.fn(),
    },
    productionActivityLog: { create: jest.fn() },
    castingSlipImage: { createMany: jest.fn() },
    warehouse: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'wh-btp', code: 'btp-cho-vao-da' }),
    },
    unit: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'unit-chiec', name: 'Chiếc' }),
    },
    stockInbound: {
      aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 3 } }),
    },
    $queryRaw: jest.fn(),
  };
  const prisma = {
    runTx: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const inventory = {
    ensureNamedMaterial: jest.fn().mockResolvedValue('material-id'),
    createAutoInbound: jest.fn().mockResolvedValue('inbound-id'),
    bustBtpStock: jest.fn(),
    bustNvlStock: jest.fn(),
  };
  const cloudinary = { ownsPublicId: jest.fn().mockReturnValue(true) };
  const service = new CastingSlipsService(
    prisma as never,
    cloudinary as never,
    inventory as never,
  );
  jest.spyOn(service, 'getById').mockResolvedValue({ id: 'slip' } as never);
  const dto = {
    blanks: [
      { intakeOrderId: '1', qty: 2, weightGram: 4, images: [image] },
      { intakeOrderId: '2', qty: 2, weightGram: 5, images: [image] },
    ],
    restWeightGram: 1,
    restImages: [image],
  };
  return { service, dto, tx, inventory, prisma };
}

describe('cắt cây thông sau Đúc xong → Chờ nguội', () => {
  it('chỉ chuyển đơn sẵn có sang Chờ nguội, không tạo lệnh / phiếu mới', async () => {
    const { service, dto, tx, inventory } = setup(10);
    await service.confirm('slip', dto, actor);

    expect(tx.productionOrder.create).not.toHaveBeenCalled();
    expect(tx.productionOrder.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['1', '2'] }, status: 'CAST_DONE', cutAt: null },
      data: { status: 'WAIT_FILING' },
    });
    expect(tx.productionOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '1' },
        data: expect.objectContaining({
          blankQty: 2,
          cutAt: expect.any(Date) as unknown,
        }) as unknown,
      }),
    );
    expect(inventory.createAutoInbound).toHaveBeenCalledTimes(3);
    // Phôi ghi theo dòng phiếu đúc — mốc hao hụt cắt.
    expect(tx.castingSlipOrder.update).toHaveBeenCalledTimes(2);
    expect(tx.castingSlipOrder.update).toHaveBeenNthCalledWith(1, {
      where: { orderId: '1' },
      data: { blankQty: 2, blankWeightGram: new Prisma.Decimal(4) },
    });
    expect(inventory.bustBtpStock).toHaveBeenCalled();
  });

  it('không ghi gì nếu tổng phôi vượt trọng lượng cây sau đúc', async () => {
    const { service, dto, tx, inventory } = setup(9);
    await expect(service.confirm('slip', dto, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.castingSlip.updateMany).not.toHaveBeenCalled();
    expect(tx.productionOrder.create).not.toHaveBeenCalled();
    expect(inventory.createAutoInbound).not.toHaveBeenCalled();
  });
  it.each(['WAIT_CASTING', 'CASTING', 'PENDING_CONFIRMATION', 'CAST_FAILED'])(
    'chặn cắt khi phiếu ở trạng thái %s dù các đơn có số liệu đúc',
    async (status) => {
      const { service, dto, tx, inventory } = setup(10);
      const slip = await tx.castingSlip.findUnique();
      tx.castingSlip.findUnique.mockResolvedValue({ ...slip, status });
      await expect(service.confirm('slip', dto, actor)).rejects.toThrow(
        'Chỉ cắt cây thông sau khi Đúc xong',
      );
      expect(tx.castingSlip.updateMany).not.toHaveBeenCalled();
      expect(inventory.createAutoInbound).not.toHaveBeenCalled();
    },
  );

  it('cắt nhiều phiếu trong một giao dịch và đưa toàn bộ đơn sang Chờ nguội', async () => {
    const { service, dto, tx, prisma } = setup(10);
    const firstSlip = await tx.castingSlip.findUnique();
    tx.castingSlip.findUnique
      .mockResolvedValueOnce(firstSlip)
      .mockResolvedValueOnce({
        ...firstSlip,
        orders: [{ order: order('3') }, { order: order('4') }],
      });
    await service.cutMany(
      [
        { slipId: 'slip-1', ...dto },
        {
          slipId: 'slip-2',
          ...dto,
          blanks: dto.blanks.map((line, index) => ({
            ...line,
            intakeOrderId: String(index + 3),
          })),
        },
      ],
      actor,
    );
    expect(prisma.runTx).toHaveBeenCalledTimes(1);
    expect(tx.productionOrder.create).not.toHaveBeenCalled();
    expect(tx.productionOrder.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.productionOrder.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['3', '4'] }, status: 'CAST_DONE', cutAt: null },
      data: { status: 'WAIT_FILING' },
    });
    expect(service.getById).toHaveBeenCalledTimes(2);
  });

  it('trả lỗi từ giao dịch chung nếu một phiếu chưa đúc xong, không báo thành công một phần', async () => {
    const { service, dto, tx, inventory, prisma } = setup(10);
    const slip = await tx.castingSlip.findUnique();
    tx.castingSlip.findUnique
      .mockResolvedValueOnce(slip)
      .mockResolvedValueOnce({ ...slip, status: 'CASTING' });
    await expect(
      service.cutMany(
        [
          { slipId: 'slip-1', ...dto },
          { slipId: 'slip-2', ...dto },
        ],
        actor,
      ),
    ).rejects.toThrow('Chỉ cắt cây thông sau khi Đúc xong');
    expect(prisma.runTx).toHaveBeenCalledTimes(1);
    expect(inventory.bustBtpStock).not.toHaveBeenCalled();
    expect(service.getById).not.toHaveBeenCalled();
  });

  it('chặn chọn trùng phiếu trước khi mở giao dịch', async () => {
    const { service, dto, prisma } = setup(10);
    await expect(
      service.cutMany(
        [
          { slipId: 'slip', ...dto },
          { slipId: 'slip', ...dto },
        ],
        actor,
      ),
    ).rejects.toThrow('Mỗi phiếu đúc chỉ được chọn một lần');
    expect(prisma.runTx).not.toHaveBeenCalled();
  });

  it('chặn phiếu đã cắt khi một thao tác khác đã chốt số liệu trước', async () => {
    const { service, dto, tx } = setup(10);
    tx.castingSlip.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.confirm('slip', dto, actor)).rejects.toThrow(
      'Phiếu đúc chưa Đúc xong hoặc đã cắt cây thông',
    );
    expect(tx.productionOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.productionOrder.create).not.toHaveBeenCalled();
  });
});

describe('bước 7 cấp vật tư đúc xuất kho NVL chính', () => {
  function issueSetup() {
    const tx = {
      castingSlip: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'DABCDE',
          waxWeightGram: new Prisma.Decimal(10),
          orders: [{ orderId: '1' }, { orderId: '2' }],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      castingSlipImage: { createMany: jest.fn() },
      productionOrder: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      runTx: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const inventory = {
      issueStockForCastingSlip: jest.fn().mockResolvedValue({}),
      bustNvlStock: jest.fn(),
    };
    const service = new CastingSlipsService(
      prisma as never,
      { ownsPublicId: jest.fn().mockReturnValue(true) } as never,
      inventory as never,
    );
    jest.spyOn(service, 'getById').mockResolvedValue({ id: 'slip' } as never);
    return { service, tx, inventory };
  }

  it('xuất từng dòng có gram theo mã thủ kho chọn, gắn phiếu đúc', async () => {
    const { service, inventory } = issueSetup();
    await service.issue(
      'slip',
      {
        images: [image],
        issueS999Gram: 50,
        issueMasterAlloyGram: 5,
        issueS925Gram: 0,
        issueS999MaterialId: 'm-999',
        issueMasterAlloyMaterialId: 'm-hoi',
      },
      actor,
    );

    expect(inventory.issueStockForCastingSlip).toHaveBeenCalledTimes(2);
    expect(inventory.issueStockForCastingSlip).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        castingSlipId: 'slip',
        materialId: 'm-999',
        grams: new Prisma.Decimal(50),
        issuedBy: 'Thủ kho',
      }),
    );
    expect(inventory.issueStockForCastingSlip).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        materialId: 'm-hoi',
        grams: new Prisma.Decimal(5),
      }),
    );
    expect(inventory.bustNvlStock).toHaveBeenCalled();
  });

  it('dòng có gram mà chưa chọn mã NVL thì không cấp', async () => {
    const { service, tx, inventory } = issueSetup();
    await expect(
      service.issue(
        'slip',
        { images: [image], issueS999Gram: 50, issueS999MaterialId: undefined },
        actor,
      ),
    ).rejects.toThrow('Chọn mã NVL xuất cho Bạc S999');
    expect(tx.castingSlip.updateMany).not.toHaveBeenCalled();
    expect(inventory.issueStockForCastingSlip).not.toHaveBeenCalled();
  });

  it('không nhập số thực xuất thì xuất theo ước tính, vẫn phải chọn đủ mã', async () => {
    const { service, inventory } = issueSetup();
    await expect(
      service.issue('slip', { images: [image] }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.issue(
      'slip',
      {
        images: [image],
        issueS999MaterialId: 'm-999',
        issueMasterAlloyMaterialId: 'm-hoi',
        issueS925MaterialId: 'm-925',
      },
      actor,
    );
    expect(inventory.issueStockForCastingSlip).toHaveBeenCalledTimes(3);
  });
});
