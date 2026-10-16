import { btpMaterialName } from './intake-order';

describe('btpMaterialName — tên mã BTP tự sinh', () => {
  const order = {
    code: 'A007',
    productName: ' nhẫn cá heo ',
    intakeCode: 'DH006',
    trackingCode: 'V-233345',
  };

  it('tiền tố khâu + tên + mã đơn hàng + mã sản phẩm', () => {
    expect(btpMaterialName('Phôi', order)).toBe(
      'Phôi nhẫn cá heo - DH006 - V-233345',
    );
    expect(btpMaterialName('BTP đã nguội', order)).toBe(
      'BTP đã nguội nhẫn cá heo - DH006 - V-233345',
    );
  });

  it('thiếu tên dùng mã SX, thiếu mã thì bỏ phần đó', () => {
    expect(
      btpMaterialName('Phôi', {
        code: 'A001',
        productName: null,
        intakeCode: 'DH001',
        trackingCode: '  ',
      }),
    ).toBe('Phôi A001 - DH001');
  });
});
