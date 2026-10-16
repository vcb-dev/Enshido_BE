import { IntakeOrdersService } from './intake-orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../uploads/cloudinary.service';

/** Đơn tạo và lệnh sản xuất là một bản ghi: "đã sang lệnh SX" = đã cắt cây thông (`cutAt`). */
describe('production list handoff', () => {
  const productionOrder = {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
  };
  const service = new IntakeOrdersService(
    { productionOrder } as unknown as PrismaService,
    {} as CloudinaryService,
  );
  beforeEach(() => jest.clearAllMocks());

  it('excludes cut records from both pipeline rows and counts', async () => {
    await service.pipelineLists({});
    const { where } = productionOrder.findMany.mock.calls[0][0];
    expect(where.AND).toContainEqual({ cutAt: null });
    expect(productionOrder.groupBy.mock.calls[0][0].where).toEqual(where);
    await service.pipelineStatusCounts();
    expect(productionOrder.groupBy.mock.calls[1][0].where.AND).toContainEqual({
      cutAt: null,
    });
  });

  it('filters cooling records by cutAt before pagination when requested by the production list', async () => {
    await service.list({ status: 'WAIT_COOLING', unlinkedOnly: true });
    const { where } = productionOrder.findMany.mock.calls[0][0];
    expect(where.AND).toContainEqual({ cutAt: { not: null } });
    expect(where.AND).toContainEqual({ cutAt: null });
    expect(productionOrder.count.mock.calls[0][0].where).toEqual(where);
  });

  it('keeps cut records in the intake catalog', async () => {
    await service.list({});
    const { where } = productionOrder.findMany.mock.calls[0][0];
    expect(where.AND).not.toContainEqual({ cutAt: null });
  });
});

describe('khách VCB sửa đơn', () => {
  const vcb = {
    id: 'vcb',
    username: 'vcb',
    email: null,
    fullName: 'VCB',
    roleCode: 'USER' as const,
    extraRoles: [],
    allowedScreens: ['screen.intake-orders', 'intake.create', 'customer'],
    department: null,
  };

  it.each(['APPROVED', 'REJECTED'])(
    'đơn đã qua chờ duyệt (%s) thì khách không sửa được',
    async (status) => {
      const productionOrder = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'o1', status, cutAt: null, images: [] }),
        update: jest.fn(),
      };
      const service = new IntakeOrdersService(
        { productionOrder } as unknown as PrismaService,
        {} as CloudinaryService,
      );
      await expect(service.update('o1', {} as never, vcb)).rejects.toThrow(
        'Chỉ sửa được đơn đang chờ duyệt',
      );
      expect(productionOrder.update).not.toHaveBeenCalled();
    },
  );
});
