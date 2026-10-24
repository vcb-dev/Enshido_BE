import { LossStage, Prisma } from '@prisma/client';
import {
  buildLossReport,
  weekKeys,
  weekOf,
  weekStartKey,
  type LossItem,
} from './loss-report';

const D = (value: number) => new Prisma.Decimal(value);

function item(partial: Partial<LossItem>): LossItem {
  return {
    week: '2026-10-19',
    workerKey: 'a',
    workerUserId: 'a',
    workerName: 'A',
    stage: LossStage.FILING,
    ticketCode: 'DH001-1',
    attempt: 1,
    confirmedAt: new Date('2026-10-20T03:00:00Z'),
    qty: 10,
    inGram: D(0),
    productGram: D(0),
    btpGram: D(0),
    nvlGram: D(0),
    ...partial,
  };
}

describe('tuần báo cáo', () => {
  it('lùi về thứ Hai, Chủ nhật vẫn thuộc tuần trước', () => {
    expect(weekStartKey('2026-10-22')).toBe('2026-10-19'); // thứ Năm
    expect(weekStartKey('2026-10-19')).toBe('2026-10-19'); // thứ Hai
    expect(weekStartKey('2026-10-25')).toBe('2026-10-19'); // Chủ nhật
  });

  it('theo giờ Việt Nam: 18:00 UTC Chủ nhật đã là thứ Hai tuần sau', () => {
    expect(weekOf(new Date('2026-10-25T16:59:00Z'))).toBe('2026-10-19');
    expect(weekOf(new Date('2026-10-25T17:00:00Z'))).toBe('2026-10-26');
  });

  it('liệt kê các tuần liền nhau, cũ trước', () => {
    expect(weekKeys('2026-10-07', '2026-10-22')).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(weekKeys('2026-10-22', '2026-10-01')).toEqual([]);
  });
});

describe('buildLossReport — cột tab BÁO CÁO', () => {
  const limits = new Map([
    [LossStage.FILING, D(6)],
    [LossStage.STONE_SETTING, D(2)],
  ]);

  it('ví dụ thợ A: giao 375, trả 320 + 10 + 10 + mạt 30 → hao 5 g = 1,33%', () => {
    const [row] = buildLossReport(
      [
        item({
          qty: 20,
          inGram: D(375),
          productGram: D(320),
          btpGram: D(10),
          nvlGram: D(10),
        }),
      ],
      [
        {
          week: '2026-10-19',
          workerKey: 'a',
          workerUserId: 'a',
          workerName: 'A',
          weightGram: D(30),
        },
      ],
      limits,
    );
    expect(row.qty).toBe(20);
    expect(row.returnedGram.toString()).toBe('370');
    expect(row.lossGram.toString()).toBe('5');
    expect(row.lossPercent?.toString()).toBe('1.33');
    expect(row.limitPercent?.toString()).toBe('6');
    // Dòng khâu chưa trừ mạt (mạt trả một cục cho cả tuần).
    expect(row.stages[0].lossGram.toString()).toBe('35');
  });

  it('thợ làm nhiều khâu: mức cho phép bình quân theo TL giao', () => {
    const [row] = buildLossReport(
      [
        item({ inGram: D(300), productGram: D(290) }),
        item({
          stage: LossStage.STONE_SETTING,
          inGram: D(100),
          productGram: D(99),
        }),
      ],
      [],
      limits,
    );
    // (300 × 6 + 100 × 2) / 400 = 5
    expect(row.limitPercent?.toString()).toBe('5');
    expect(row.stages.map((stage) => stage.stage)).toEqual([
      LossStage.FILING,
      LossStage.STONE_SETTING,
    ]);
    expect(row.lossGram.toString()).toBe('11');
  });

  it('có khâu chưa đặt mức thì dòng tổng không có mức', () => {
    const [row] = buildLossReport(
      [
        item({ inGram: D(300), productGram: D(290) }),
        item({ stage: LossStage.PLATING, inGram: D(100), productGram: D(99) }),
      ],
      [],
      limits,
    );
    expect(row.limitPercent).toBeNull();
    expect(row.stages[1].limitPercent).toBeNull();
  });

  it('tách dòng theo tuần; thợ chỉ trả mạt trong tuần vẫn có dòng', () => {
    const rows = buildLossReport(
      [item({ inGram: D(100), productGram: D(95) })],
      [
        {
          week: '2026-10-26',
          workerKey: 'a',
          workerUserId: 'a',
          workerName: 'A',
          weightGram: D(3),
        },
      ],
      limits,
    );
    expect(rows.map((row) => row.week)).toEqual(['2026-10-19', '2026-10-26']);
    expect(rows[1].lossPercent).toBeNull();
    expect(rows[1].scrapGram.toString()).toBe('3');
  });
});
