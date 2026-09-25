import { Prisma } from '@prisma/client';
import {
  issuedOf,
  type IssuedRequest,
  lossPercentOf,
  recoveredOf,
  silverInOf,
  silverLossOf,
  stoneLossOf,
} from './stage-math';

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

describe('NVL xuất thêm theo yêu cầu của thợ', () => {
  const req = (over: Partial<IssuedRequest> = {}): IssuedRequest => ({
    status: 'ISSUED',
    kind: 'METAL',
    issuedWeight: dec('50'),
    issuedStoneCount: null,
    ...over,
  });

  it('chỉ cộng yêu cầu đã xuất; bạc theo gram, đá theo viên', () => {
    const issued = issuedOf([
      req(),
      req({ issuedWeight: dec('25.5') }),
      req({ status: 'PENDING' }),
      req({ kind: 'STONE', issuedWeight: dec('3'), issuedStoneCount: 40 }),
      req({ status: 'REJECTED', kind: 'STONE', issuedStoneCount: 10 }),
    ]);
    expect(issued.metal.toString()).toBe('75.5');
    expect(issued.stones).toBe(40);
  });

  it('bạc vào khâu = TL giao + bạc xuất thêm; hao hụt tính trên tổng đó', () => {
    // giao 2.000 g, xin thêm 50 g, cân lại 2.030 g → hao 20 g trên 2.050 g.
    const entry = weights({ returnedSilverWeight: dec('2030') });
    const extra = dec('50');
    expect(silverInOf(entry, extra)?.toString()).toBe('2050');
    const loss = silverLossOf(entry, extra);
    expect(loss?.toString()).toBe('20');
    expect(lossPercentOf(loss, silverInOf(entry, extra))?.toString()).toBe(
      '0.98',
    );
  });

  it('chưa cân lúc giao nhưng có bạc xuất thêm thì mốc là phần xuất', () => {
    const entry = weights({
      handedSilverWeight: null,
      returnedSilverWeight: dec('48'),
    });
    expect(silverLossOf(entry, dec('50'))?.toString()).toBe('2');
  });

  it('đá mất = phát lúc giao + xuất thêm − gắn − trả lại', () => {
    const stone = stoneLossOf(
      {
        handedStoneCount: 100,
        stoneCount: 130,
        returnedStoneCount: 15,
        returnedAt: new Date(),
      },
      50,
    );
    expect(stone).toEqual({ stonesIn: 150, loss: 5 });
  });

  it('KCS chưa nhận lại thì chưa có đá mất', () => {
    expect(
      stoneLossOf(
        {
          handedStoneCount: 10,
          stoneCount: null,
          returnedStoneCount: null,
          returnedAt: null,
        },
        0,
      ),
    ).toEqual({ stonesIn: 10, loss: null });
  });
});
