import { IntakeOrdersService } from './intake-orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../uploads/cloudinary.service';

describe('production list handoff', () => {
  const intakeOrder = {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
  };
  const service = new IntakeOrdersService(
    { intakeOrder } as unknown as PrismaService,
    {} as CloudinaryService,
  );
  beforeEach(() => jest.clearAllMocks());

  it('excludes linked intake records from both pipeline rows and counts', async () => {
    await service.pipelineLists({});
    const { where } = intakeOrder.findMany.mock.calls[0][0];
    expect(where.AND).toContainEqual(expect.objectContaining({ productionOrder: { is: null } }));
    expect(intakeOrder.groupBy.mock.calls[0][0].where).toEqual(where);
    await service.pipelineStatusCounts();
    expect(intakeOrder.groupBy.mock.calls[1][0].where.productionOrder).toEqual({ is: null });
  });

  it('filters linked cooling records before pagination when requested by the production list', async () => {
    await service.list({ status: 'WAIT_COOLING', unlinkedOnly: true });
    expect(intakeOrder.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'WAIT_COOLING', productionOrder: { is: null },
    });
    expect(intakeOrder.count.mock.calls[0][0].where).toEqual(intakeOrder.findMany.mock.calls[0][0].where);
  });

  it('keeps linked records in the intake catalog', async () => {
    await service.list({});
    expect(intakeOrder.findMany.mock.calls[0][0].where).not.toHaveProperty('productionOrder');
  });
});
