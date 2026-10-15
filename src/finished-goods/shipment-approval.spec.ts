import { BadRequestException } from '@nestjs/common';
import { Prisma, ProductionStatus, RoleCode } from '@prisma/client';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { FinishedGoodsService } from './finished-goods.service';

const accountant: AuthUserPayload = {
  id: 'kt',
  username: 'kt',
  email: null,
  fullName: 'Kế toán',
  roleCode: RoleCode.USER,
  extraRoles: [],
  allowedScreens: [Permission.ACCOUNTING_APPROVE],
  department: null,
};

const d = (value: number) => new Prisma.Decimal(value);

function shipment(pendingApproval: boolean, complete = true) {
  return {
    id: 'sh1',
    code: 'PX0001',
    pendingApproval,
    approvedAt: null,
    autoIssued: false,
    lines: [
      {
        orderId: 'o1',
        weightGram: d(10),
        materialUnitPrice: d(30000),
        laborAmount: d(100000),
        stoneAmount: complete ? d(0) : null,
        otherAmount: d(0),
      },
    ],
  };
}

function setup(row: ReturnType<typeof shipment>) {
  const tx = {
    shipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    productionOrder: {
      // Đơn đã nhận đủ 2 sp vào kho; phiếu PX0001 vừa duyệt xuất cả 2.
      findUnique: jest.fn().mockResolvedValue({
        qty: 2,
        status: ProductionStatus.FINISHING,
        returnedQty: 0,
        receipt: { qty: 2, stockedQty: 2 },
        shipmentLines: [{ qty: 2 }],
      }),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const service = new FinishedGoodsService(prisma as never, {} as never);
  const internals = service as unknown as {
    requireShipment: (code: string) => Promise<unknown>;
  };
  jest.spyOn(internals, 'requireShipment').mockResolvedValue(row);
  jest.spyOn(service, 'shipment').mockResolvedValue({} as never);
  return { service, tx };
}

describe('bước 23 kế toán xác nhận phiếu xuất', () => {
  it('xác nhận thì ghi người duyệt và đơn sang Đã giao', async () => {
    const { service, tx } = setup(shipment(true));
    await service.approve('PX0001', accountant);

    expect(tx.shipment.updateMany).toHaveBeenCalledWith({
      where: { id: 'sh1', pendingApproval: true },
      data: expect.objectContaining({
        pendingApproval: false,
        approvedByUserId: 'kt',
        approvedByName: 'Kế toán',
      }) as unknown,
    });
    // Chỉ tính các phiếu đã xác nhận vào số đã giao.
    expect(tx.productionOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          shipmentLines: {
            where: { shipment: { pendingApproval: false } },
            select: { qty: true },
          },
        }) as unknown,
      }),
    );
    expect(tx.productionOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o1' },
        data: expect.objectContaining({
          returnedQty: 2,
          status: ProductionStatus.DELIVERED,
        }) as unknown,
      }),
    );
  });

  it('phiếu còn thiếu khoản thì chưa xác nhận được', async () => {
    const { service, tx } = setup(shipment(true, false));
    await expect(service.approve('PX0001', accountant)).rejects.toThrow(
      'rồi mới xác nhận',
    );
    expect(tx.shipment.updateMany).not.toHaveBeenCalled();
  });

  it('phiếu không chờ duyệt thì không xác nhận lại được', async () => {
    const { service, tx } = setup(shipment(false));
    await expect(service.approve('PX0001', accountant)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.shipment.updateMany).not.toHaveBeenCalled();
  });
});
