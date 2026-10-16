import { Prisma, ProductionStage } from '@prisma/client';
import {
  gramOf,
  invoiceAmount,
  invoiceComplete,
  netGramPerUnit,
  type WeightStageEntry,
} from './shipment-weight';

const d = (value: string) => new Prisma.Decimal(value);

function entry(overrides: Partial<WeightStageEntry>): WeightStageEntry {
  return {
    stage: ProductionStage.PLATING,
    subTicketId: null,
    attempt: 1,
    returnedAt: new Date('2026-10-10'),
    handedQty: null,
    returnedQty: null,
    returnedSilverWeight: null,
    stoneWeight: null,
    ...overrides,
  };
}

describe('netGramPerUnit', () => {
  it('trừ đá gắn ở Vào đá khỏi TL sau Xi, chia theo chiếc', () => {
    const entries = [
      entry({
        stage: ProductionStage.STONE_SETTING,
        handedQty: 2,
        returnedQty: 2,
        stoneWeight: d('1'),
      }),
      entry({ returnedQty: 2, returnedSilverWeight: d('21') }),
    ];
    // (21 / 2) − (1 / 2) = 10
    expect(netGramPerUnit(entries, true)?.toString()).toBe('10');
  });

  it('đơn không đá chỉ lấy TL sau Xi', () => {
    const entries = [entry({ returnedQty: 1, returnedSilverWeight: d('8') })];
    expect(netGramPerUnit(entries, false)?.toString()).toBe('8');
  });

  it('lấy lần Xi gần nhất của từng phiếu và cộng các phiếu con', () => {
    const entries = [
      entry({
        subTicketId: 'a',
        attempt: 1,
        returnedQty: 1,
        returnedSilverWeight: d('99'),
      }),
      entry({
        subTicketId: 'a',
        attempt: 2,
        returnedQty: 1,
        returnedSilverWeight: d('5'),
      }),
      entry({ subTicketId: 'b', returnedQty: 1, returnedSilverWeight: d('7') }),
    ];
    expect(netGramPerUnit(entries, false)?.toString()).toBe('6');
  });

  it('null khi chưa cân Xi hoặc có đá mà chưa ghi đá gắn', () => {
    expect(netGramPerUnit([], false)).toBeNull();
    expect(
      netGramPerUnit(
        [entry({ returnedQty: 1, returnedSilverWeight: d('8') })],
        true,
      ),
    ).toBeNull();
    expect(
      netGramPerUnit(
        [
          entry({
            returnedAt: null,
            returnedQty: 1,
            returnedSilverWeight: d('8'),
          }),
        ],
        false,
      ),
    ).toBeNull();
  });
});

describe('gramOf', () => {
  it('× SL × 0,95, làm tròn 2 số', () => {
    // 34,7368 g × 0,95 = 33,00 g
    expect(gramOf(d('34.7368'), 1)?.toString()).toBe('33');
    expect(gramOf(d('10.1234'), 3)?.toString()).toBe('28.85');
    expect(gramOf(null, 1)).toBeNull();
  });
});

describe('invoiceAmount', () => {
  const parts = {
    weightGram: d('40'),
    materialUnitPrice: d('55000'),
    laborAmount: d('1500000'),
    stoneAmount: d('150000'),
    otherAmount: d('400000'),
  };

  it('khớp mẫu hoá đơn sản xuất', () => {
    expect(invoiceAmount(parts).toString()).toBe('4250000');
    expect(invoiceComplete(parts)).toBe(true);
  });

  it('thiếu khoản nào là chưa in được', () => {
    expect(invoiceComplete({ ...parts, stoneAmount: null })).toBe(false);
    expect(invoiceComplete({ ...parts, stoneAmount: d('0') })).toBe(true);
  });
});
