import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProductionMaterialRequestsService } from './production-material-requests.service';

const photo = (publicId: string, host = 'res.cloudinary.com') => ({
  url: `https://${host}/demo/image/upload/${publicId}.jpg`,
  publicId,
});

describe('ảnh gói đá lúc cấp', () => {
  const service = new ProductionMaterialRequestsService(
    {} as never,
    {} as never,
    { ownsPublicId: (id: string) => id.startsWith('enshido/') } as never,
  );

  it('bắt buộc ít nhất một ảnh cho mỗi dòng đá', () => {
    expect(() => service.stoneImages([])).toThrow(BadRequestException);
    expect(() => service.stoneImages(undefined)).toThrow('ảnh gói đá');
  });

  it('bỏ ảnh trùng và đánh thứ tự', () => {
    expect(
      service.stoneImages([
        photo('enshido/a'),
        photo('enshido/a'),
        photo('enshido/b'),
      ]),
    ).toEqual([
      expect.objectContaining({ publicId: 'enshido/a', sortOrder: 0 }),
      expect.objectContaining({ publicId: 'enshido/b', sortOrder: 1 }),
    ]);
  });

  it('không nhận ảnh ngoài kho ảnh của hệ thống', () => {
    expect(() => service.stoneImages([photo('other/a')])).toThrow(
      'không thuộc kho ảnh',
    );
    expect(() =>
      service.stoneImages([photo('enshido/a', 'evil.example.com')]),
    ).toThrow('không thuộc kho ảnh');
  });
});

describe('đá lúc giao khâu Vào đá', () => {
  it('chỉ giữ chỗ — không ghi thêm thành yêu cầu đã xuất (tránh cộng đôi đá vào khâu)', async () => {
    const inventory = {
      stockOnHand: jest.fn().mockResolvedValue(new Prisma.Decimal(100)),
      heldQty: jest.fn().mockResolvedValue(new Prisma.Decimal(0)),
      createOutboundDraft: jest.fn().mockResolvedValue({ id: 'draft' }),
    };
    const service = new ProductionMaterialRequestsService(
      {} as never,
      inventory as never,
      { ownsPublicId: () => true } as never,
    );
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      material: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'stones',
          name: 'Đá tròn 1.5',
          sku: 'DA15',
          warehouseId: 'nvl',
          unit: { id: 'u', name: 'viên' },
          warehouse: { code: 'nvl-chinh' },
        }),
      },
      productionStoneHold: {
        create: jest.fn().mockResolvedValue({ id: 'hold' }),
      },
      productionMaterialRequest: { create: jest.fn() },
    };
    const order = { id: 'order', code: 'A010', subTickets: [] };
    const touched = await service.issueAtHandover(
      tx as never,
      order as never,
      { id: 'entry', stage: 'STONE_SETTING', subTicketId: null },
      [
        {
          materialId: 'stones',
          kind: 'STONE',
          qty: '20',
          weight: '2',
          images: [photo('enshido/a')],
        },
      ],
      { id: 'keeper', fullName: 'Thủ kho', username: 'keeper' } as never,
    );
    expect(touched).toEqual(['nvl-chinh']);
    expect(tx.productionMaterialRequest.create).not.toHaveBeenCalled();
    const held = tx.productionStoneHold.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(held[0].data).toMatchObject({
      stageEntryId: 'entry',
      requestId: null,
      stoneCount: 20,
      weight: new Prisma.Decimal(2),
    });
  });
});
