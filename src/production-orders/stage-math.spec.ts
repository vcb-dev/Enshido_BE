import { Prisma } from '@prisma/client';
import { recoveredOf, silverLossOf } from './stage-math';

const dec = (value: string) => new Prisma.Decimal(value);

/** Một khâu đã nhận lại — chỉ các trường hàm tính hao hụt đọc tới. */
function weights(over: Partial<Parameters<typeof silverLossOf>[0]> = {}) {
  return {
    handedSilverWeight: dec('2000'),
    returnedSilverWeight: dec('1980'),
    btpRecoveredWeight: null,
    silverRecoveredWeight: null,
    ...over,
  };
}

describe('silverLossOf — hao hụt bạc của một khâu', () => {
  it('chưa cân lại thì chưa có hao hụt', () => {
    expect(silverLossOf(weights({ returnedSilverWeight: null }))).toBeNull();
  });

  it('giao 2.000 nhận 1.980 là hao 20 g', () => {
    expect(silverLossOf(weights())?.toString()).toBe('20');
  });

  it('trừ cả BTP và bạc thu hồi', () => {
    const loss = silverLossOf(
      weights({
        returnedSilverWeight: dec('1900'),
        btpRecoveredWeight: dec('50'),
        silverRecoveredWeight: dec('30'),
      }),
    );
    expect(loss?.toString()).toBe('20');
  });

  it('khâu Vào đá: đá gắn thêm cộng vào vế giao vì cân cả cụm', () => {
    // giao 2.000 g bạc + gắn 80 g đá, cân cả cụm được 2.060 g → hao 20 g bạc.
    const loss = silverLossOf(
      weights({ stoneWeight: dec('80'), returnedSilverWeight: dec('2060') }),
    );
    expect(loss?.toString()).toBe('20');
  });

  it('không có đá thì công thức giữ nguyên như cũ', () => {
    expect(silverLossOf(weights({ stoneWeight: null }))?.toString()).toBe('20');
  });
});

describe('recoveredOf — bạc + BTP thu hồi', () => {
  it('cộng hai loại thu hồi, trống tính là 0', () => {
    expect(
      recoveredOf(
        weights({ btpRecoveredWeight: dec('50'), silverRecoveredWeight: null }),
      ).toString(),
    ).toBe('50');
  });
});
