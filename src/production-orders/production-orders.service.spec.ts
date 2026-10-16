import { ForbiddenException } from '@nestjs/common';
import { ProductionStatus, RoleCode } from '@prisma/client';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { ProductionOrdersService } from './production-orders.service';

const qc: AuthUserPayload = {
  id: 'qc',
  username: 'qc',
  email: null,
  fullName: 'QC',
  roleCode: RoleCode.USER,
  extraRoles: [],
  allowedScreens: [Permission.PRODUCTION_QC],
  department: null,
};

describe('đổi trạng thái lệnh SX', () => {
  it.each([ProductionStatus.NEW, ProductionStatus.REDO_3D])(
    'QC không được chuyển đơn về %s',
    async (status) => {
      const productionOrder = {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          code: 'A010',
          status: ProductionStatus.FILING,
        }),
        update: jest.fn(),
      };
      const service = new ProductionOrdersService(
        { productionOrder } as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(
        service.changeStatus('A010', { status }, qc),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(productionOrder.update).not.toHaveBeenCalled();
    },
  );
});
