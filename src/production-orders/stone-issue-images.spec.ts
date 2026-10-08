import { BadRequestException } from '@nestjs/common';
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
