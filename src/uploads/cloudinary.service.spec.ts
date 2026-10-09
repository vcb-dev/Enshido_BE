import { CloudinaryService } from './cloudinary.service';

describe('Cloudinary — ảnh QC dùng chung', () => {
  it('giữ ảnh còn được khâu QC tham chiếu, chỉ xoá ảnh không còn dùng', async () => {
    const empty = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = {
      materialImage: empty,
      productionOrderImage: empty,
      intakeOrderImage: empty,
      castingSlipImage: empty,
      productionStoneHoldImage: empty,
      productionStageImage: {
        findMany: jest.fn().mockResolvedValue([{ publicId: 'enshido/shared' }]),
      },
    };
    const service = new CloudinaryService({} as never, prisma as never);
    const cleanup = service as unknown as {
      unreferenced: (ids: string[]) => Promise<string[]>;
    };
    await expect(
      cleanup.unreferenced(['enshido/shared', 'enshido/unused']),
    ).resolves.toEqual(['enshido/unused']);
  });
});
