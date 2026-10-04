import { BadRequestException } from '@nestjs/common';
import {
  IntakeOrderStatus,
  Prisma,
  ProductionRequestType,
  RoleCode,
} from '@prisma/client';
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

function intake(id: string) {
  return {
    id,
    code: `DH${id}`,
    status: IntakeOrderStatus.CAST_DONE,
    requestType: ProductionRequestType.BULK,
    productName: 'Nhẫn',
    qty: 2,
    trackingCode: `SP${id}`,
    placedBy: 'Quản lý',
    description: '',
    createdDate: new Date('2026-09-29'),
    dueDate: null,
    model3dUrl: null,
    productionOrder: null,
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
        orders: [{ intake: intake('1') }, { intake: intake('2') }],
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    intakeOrder: {
      updateMany: jest.fn().mockImplementation(
        async (args: { where?: { id?: string | { in?: string[] } } }) => ({
          count: Array.isArray(args.where?.id)
            ? 1
            : args.where?.id && typeof args.where.id === 'object' && args.where.id.in
              ? args.where.id.in.length
              : 1,
        }),
      ),
    },
    castingSlipOrder: { update: jest.fn().mockResolvedValue({}) },
    productionOrder: {
      findFirst: jest.fn().mockResolvedValue({ seq: 42 }),
      create: jest
        .fn()
        .mockResolvedValueOnce({ id: 'order-1' })
        .mockResolvedValueOnce({ id: 'order-2' }),
      update: jest.fn(),
    },
    productionActivityLog: { create: jest.fn() },
    castingSlipImage: { createMany: jest.fn() },
    warehouse: {
      findUnique: jest.fn().mockResolvedValue({ id: 'wh-btp', code: 'btp-cho-vao-da' }),
    },
    unit: {
      findUnique: jest.fn().mockResolvedValue({ id: 'unit-chiec', name: 'Chiếc' }),
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
  return { service, dto, tx, inventory };
}

describe('xác nhận đúc → Nguội', () => {
  it('tạo đúng một lệnh và một phiếu nhập phôi cho mỗi đơn, không tạo phiếu cắt', async () => {
    const { service, dto, tx, inventory } = setup(10);
    await service.confirm('slip', dto, actor);

    expect(tx.productionOrder.create).toHaveBeenCalledTimes(2);
    expect(tx.productionOrder.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'A043',
          status: 'WAIT_FILING',
          blankQty: 2,
          intakeOrderId: '1',
        }) as unknown,
      }),
    );
    expect(tx.productionOrder.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'A044',
          status: 'WAIT_FILING',
          blankQty: 2,
          intakeOrderId: '2',
        }) as unknown,
      }),
    );
    expect(inventory.createAutoInbound).toHaveBeenCalledTimes(3);
    // Phôi ghi theo dòng phiếu đúc — mốc hao hụt cắt, không lẫn phôi phiếu bù.
    expect(tx.castingSlipOrder.update).toHaveBeenCalledTimes(2);
    expect(tx.castingSlipOrder.update).toHaveBeenNthCalledWith(1, {
      where: { intakeOrderId: '1' },
      data: { blankQty: 2, blankWeightGram: new Prisma.Decimal(4) },
    });
    expect(tx.intakeOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'WAIT_COOLING' },
      }),
    );
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
});
