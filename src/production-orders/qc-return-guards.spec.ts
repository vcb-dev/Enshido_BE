import { BadRequestException } from '@nestjs/common';
import { ProductionStage, RoleCode } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { Permission } from '../auth/permissions';
import type { ReturnStageDto } from './dto/production-order.dto';
import { ProductionOrdersService } from './production-orders.service';

const actor: AuthUserPayload = {
  id: 'qc',
  username: 'qc',
  email: null,
  fullName: 'QC',
  roleCode: RoleCode.USER,
  extraRoles: [],
  allowedScreens: [Permission.PRODUCTION_QC],
  department: null,
};

/** Khâu Nguội của phiếu con đã báo xong — chỉ đủ trường để chạy tới các bước chặn kết quả QC. */
function orderWith(stage: ProductionStage) {
  return {
    code: 'A002',
    id: 'order-1',
    updatedAt: new Date('2026-10-04T04:00:00Z'),
    qty: 50,
    materialRequests: [],
    stoneHolds: [],
    subTickets: [],
    stages: [
      {
        id: 'stage-1',
        stage,
        subTicketId: 'ticket-1',
        handedQty: 50,
        handedAt: new Date('2026-10-04T03:00:00Z'),
        submittedAt: new Date('2026-10-04T04:00:00Z'),
        defectReportedAt: null,
        returnedAt: null,
        confirmedAt: null,
        kcsRevisionCount: 0,
        images: [],
      },
    ],
  };
}

function serviceFor(stage: ProductionStage) {
  const service = new ProductionOrdersService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  (
    service as unknown as { requireOrder: () => Promise<unknown> }
  ).requireOrder = () => Promise.resolve(orderWith(stage));
  return service;
}

function dto(patch: Partial<ReturnStageDto>): ReturnStageDto {
  return {
    returnedAt: '2026-10-04T05:00:00Z',
    returnedQty: 50,
    returnedSilverWeight: '6.5',
    images: [],
    ...patch,
  };
}

describe('QC cân lại Nguội / Vào đá — chặn kết quả lỗi thiếu thông tin', () => {
  it('không cho chuyển khâu với sản phẩm đạt nhưng TL bằng 0', async () => {
    await expect(
      serviceFor(ProductionStage.FILING).returnStage(
        'A002',
        'stage-1',
        dto({ returnedQty: 50, returnedSilverWeight: '0' }),
        actor,
      ),
    ).rejects.toThrow('trọng lượng sản phẩm đạt phải lớn hơn 0');
  });
  it.each([ProductionStage.FILING, ProductionStage.STONE_SETTING])(
    '%s: đạt 0 sp mà không ghi hàng lỗi thì báo lỗi',
    async (stage) => {
      const service = serviceFor(stage);
      await expect(
        service.returnStage(
          'A002',
          'stage-1',
          dto({ returnedQty: 0, returnedSilverWeight: '0', defectQty: 0 }),
          actor,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Đạt 0 sản phẩm — ghi số lượng hàng lỗi và lý do lỗi',
        ),
      );
    },
  );

  it('có hàng lỗi mà thiếu lý do thì báo lỗi', async () => {
    const service = serviceFor(ProductionStage.FILING);
    await expect(
      service.returnStage(
        'A002',
        'stage-1',
        dto({ returnedQty: 45, defectQty: 5, defectReason: '   ' }),
        actor,
      ),
    ).rejects.toThrow(new BadRequestException('Có hàng lỗi — ghi lý do lỗi'));
  });

  it('lỗi hết có SL lỗi + lý do thì qua được bước chặn', async () => {
    const service = serviceFor(ProductionStage.FILING);
    // Qua bước chặn thì tới phần ghi DB — mock rỗng nên lỗi khác, không phải lỗi chặn.
    await expect(
      service.returnStage(
        'A002',
        'stage-1',
        dto({
          returnedQty: 0,
          returnedSilverWeight: '0',
          defectQty: 50,
          defectReason: 'Rỗ',
          btpRecoveredWeight: '6.5',
        }),
        actor,
      ),
    ).rejects.not.toThrow(/ghi số lượng hàng lỗi|ghi lý do lỗi/);
  });
});

describe('QC lưu kết quả khi phiếu bị thay đổi đồng thời', () => {
  it.each(['confirmed', 'revised', 'returned', 'order_changed'])(
    'chặn ghi đè khi %s xảy ra sau lúc đọc đơn',
    async (change) => {
      const order = orderWith(ProductionStage.FILING);
      const entry = order.stages[0];
      const returnedAt = new Date('2026-10-04T05:00:00Z');
      const revising = change === 'confirmed' || change === 'revised';
      const snapshot = { ...entry, returnedAt: revising ? returnedAt : null };
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        productionOrder: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            updatedAt:
              change === 'order_changed' ? returnedAt : order.updatedAt,
            stages: [
              {
                returnedAt:
                  revising || change === 'returned' ? returnedAt : null,
                confirmedAt: change === 'confirmed' ? returnedAt : null,
                kcsRevisionCount: change === 'revised' ? 1 : 0,
              },
            ],
          }),
          update: jest.fn(),
        },
      };
      const service = new ProductionOrdersService(
        {
          runTx: (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
        } as never,
        { ownsPublicId: () => true } as never,
        {} as never,
        {} as never,
      );
      (
        service as unknown as { requireOrder: () => Promise<unknown> }
      ).requireOrder = () => Promise.resolve({ ...order, stages: [snapshot] });
      await expect(
        service.returnStage(
          'A002',
          entry.id,
          dto({
            returnedQty: 45,
            defectQty: 5,
            defectReason: 'Rỗ',
            images: [
              {
                url: 'https://res.cloudinary.com/test/image/upload/enshido/qc',
                publicId: 'enshido/qc',
              },
            ],
          }),
          actor,
          revising,
        ),
      ).rejects.toThrow('Phiếu đã thay đổi');
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.productionOrder.update).not.toHaveBeenCalled();
    },
  );
});
