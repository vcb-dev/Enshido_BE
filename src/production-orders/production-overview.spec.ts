import { ProductionStatus } from '@prisma/client';
import {
  addMonthKey,
  bucketIndexByDay,
  overviewBuckets,
  previousPeriod,
  compareWatch,
  isFirstPass,
  isOverdue,
  orderPositions,
  vnDayKey,
  vnDayStart,
  batchCodes,
  returnedItems,
  workerPerformance,
  type OverviewOrder,
  type PerformanceItem,
} from './production-overview';

const S = ProductionStatus;
const RETURNED = new Date('2026-10-14T03:00:00Z');

function order(overrides: Partial<OverviewOrder> = {}): OverviewOrder {
  return {
    id: 'o1',
    code: 'A010',
    intakeCode: 'DH010',
    productName: 'Nhẫn moissanite',
    btpName: null,
    description: 'Mô tả',
    qty: 24,
    status: S.FILING,
    dueDate: new Date('2026-10-14T00:00:00Z'),
    claimedByUserId: null,
    claimedByName: null,
    pendingStage: null,
    stoneCount: 10,
    stoneWeight: null,
    stoneSkipped: false,
    receipt: null,
    subTickets: [],
    stages: [],
    ...overrides,
  };
}

type Entry = OverviewOrder['stages'][number];
function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    subTicketId: null,
    stage: 'FILING',
    returnedAt: null,
    confirmedAt: null,
    submittedAt: null,
    defectReportedAt: null,
    returnedQty: null,
    craftsmanName: 'Thợ nguội A',
    ...overrides,
  };
}

type Ticket = OverviewOrder['subTickets'][number];
function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    no: 1,
    qty: 10,
    pendingStage: null,
    claimedByUserId: null,
    claimedByName: null,
    outcome: null,
    ...overrides,
  };
}

describe('orderPositions — hàng của đơn nằm ở công đoạn nào', () => {
  it('đơn chưa chia: cả đơn một chỗ, thợ lấy từ khâu đang mở', () => {
    const [position] = orderPositions(order({ stages: [entry()] }));
    expect(position).toMatchObject({
      code: 'A010',
      orderCode: 'DH010',
      stage: 'FILING',
      working: true,
      qty: 24,
      assignee: 'Thợ nguội A',
      dueDate: '2026-10-14',
    });
  });

  it('luồng trước Nguội và trạng thái chờ', () => {
    expect(orderPositions(order({ status: S.WAX_PRINTED }))[0]).toMatchObject({
      stage: 'MODEL',
      working: true,
    });
    expect(orderPositions(order({ status: S.WAIT_CASTING }))[0]).toMatchObject({
      stage: 'CASTING',
      working: false,
    });
    expect(orderPositions(order({ status: S.CAST_DONE }))[0].stage).toBe('CUT');
    expect(orderPositions(order({ status: S.WAIT_STONE }))[0]).toMatchObject({
      stage: 'STONE_SETTING',
      working: false,
    });
  });

  it('không tính đơn chờ duyệt, lỗi, đã xong', () => {
    for (const status of [
      S.PENDING_APPROVAL,
      S.REJECTED,
      S.DEFECT,
      S.FILING_DEFECT,
      S.FINISHING,
      S.DELIVERED,
    ]) {
      expect(orderPositions(order({ status }))).toEqual([]);
    }
  });

  it('Đã xi xong: chỉ tính phần kho chưa nhận', () => {
    const plated = order({
      status: S.PLATED,
      receipt: { qty: 24, stockedQty: 20 },
    });
    expect(orderPositions(plated)[0]).toMatchObject({ stage: 'STOCK', qty: 4 });
    expect(
      orderPositions(
        order({ status: S.PLATED, receipt: { qty: 5, stockedQty: 5 } }),
      ),
    ).toEqual([]);
  });

  it('đơn đã chia: mỗi phiếu con chưa chốt một chỗ, phiếu đã chốt bỏ qua', () => {
    const positions = orderPositions(
      order({
        status: S.ENGRAVING,
        subTickets: [
          ticket({ id: 't1', no: 1, qty: 10 }),
          ticket({
            id: 't2',
            no: 2,
            qty: 8,
            pendingStage: 'STONE_SETTING',
            claimedByUserId: 'u2',
            claimedByName: 'Thợ đá B',
          }),
          ticket({ id: 't3', no: 3, qty: 6, outcome: 'FINISH' }),
        ],
        stages: [
          entry({
            subTicketId: 't1',
            stage: 'FILING',
            returnedAt: RETURNED,
            confirmedAt: RETURNED,
          }),
          entry({
            subTicketId: 't1',
            stage: 'STONE_SETTING',
            returnedAt: RETURNED,
            confirmedAt: RETURNED,
          }),
          entry({
            subTicketId: 't1',
            stage: 'ENGRAVING',
            craftsmanName: 'Thợ khắc C',
          }),
        ],
      }),
    );
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      code: 'A010-1',
      stage: 'ENGRAVING',
      working: true,
      qty: 10,
      assignee: 'Thợ khắc C',
    });
    expect(positions[1]).toMatchObject({
      code: 'A010-2',
      stage: 'STONE_SETTING',
      working: false,
      qty: 8,
      assignee: 'Thợ đá B',
    });
  });
});

describe('isOverdue / compareWatch', () => {
  const [position] = orderPositions(order());

  it('quá hạn khi hạn giao trước hôm nay', () => {
    expect(isOverdue(position, '2026-10-15')).toBe(true);
    expect(isOverdue(position, '2026-10-14')).toBe(false);
    expect(isOverdue({ ...position, dueDate: null }, '2026-10-15')).toBe(false);
  });

  it('hạn gần nhất trước, không có hạn xếp cuối', () => {
    const rows = [
      { ...position, code: 'C', dueDate: null },
      { ...position, code: 'B', dueDate: '2026-10-16' },
      { ...position, code: 'A', dueDate: '2026-10-13' },
    ].sort(compareWatch);
    expect(rows.map((row) => row.code)).toEqual(['A', 'B', 'C']);
  });
});

describe('isFirstPass', () => {
  it('chỉ lần đầu, không báo lỗi, không SL lỗi', () => {
    const base = { attempt: 1, defectQty: null, defectReportedAt: null };
    expect(isFirstPass(base)).toBe(true);
    expect(isFirstPass({ ...base, defectQty: 0 })).toBe(true);
    expect(isFirstPass({ ...base, attempt: 2 })).toBe(false);
    expect(isFirstPass({ ...base, defectQty: 1 })).toBe(false);
    expect(isFirstPass({ ...base, defectReportedAt: RETURNED })).toBe(false);
  });
});

describe('vnDayKey / vnDayStart', () => {
  it('chia ngày theo giờ Việt Nam', () => {
    expect(vnDayKey(new Date('2026-10-15T16:59:00Z'))).toBe('2026-10-15');
    expect(vnDayKey(new Date('2026-10-15T17:00:00Z'))).toBe('2026-10-16');
    expect(vnDayStart('2026-10-16').toISOString()).toBe(
      '2026-10-15T17:00:00.000Z',
    );
    expect(vnDayStart('2026-10-16', -6).toISOString()).toBe(
      '2026-10-09T17:00:00.000Z',
    );
  });
});

describe('returnedItems — QC nhận lại tách hoàn thiện / lỗi', () => {
  const base = {
    orderId: 'o1',
    stage: 'FILING' as const,
    craftsmanUserId: 'u1',
    craftsmanName: 'Thợ A',
  };

  it('có đạt và lỗi thì ra hai phần, SL 0 thì bỏ', () => {
    expect(
      returnedItems({ ...base, returnedQty: 8, defectQty: 2 }).map((i) => [
        i.status,
        i.qty,
      ]),
    ).toEqual([
      ['DONE', 8],
      ['DEFECT', 2],
    ]);
    expect(
      returnedItems({ ...base, returnedQty: 0, defectQty: 5 }),
    ).toHaveLength(1);
    expect(
      returnedItems({ ...base, returnedQty: null, defectQty: null }),
    ).toEqual([]);
  });
});

describe('workerPerformance — thợ × khâu × trạng thái', () => {
  const item = (overrides: Partial<PerformanceItem>): PerformanceItem => ({
    orderId: 'o1',
    stage: 'FILING',
    workerId: 'u1',
    workerName: 'Thợ An',
    status: 'DONE',
    qty: 5,
    ...overrides,
  });

  it('nhiều phiếu con cùng đơn tính một đơn, SL cộng dồn, tổng đơn không đếm trùng', () => {
    const { rows, totals } = workerPerformance([
      item({}),
      item({}),
      item({ orderId: 'o2', status: 'WORKING', qty: 3 }),
      item({ status: 'DEFECT', qty: 1 }),
      item({ workerId: 'u2', workerName: 'Thợ Bình' }),
      item({ stage: 'PLATING', status: 'PENDING', qty: 4 }),
    ]);
    expect(rows.map((r) => r.workerName)).toEqual(['Thợ An', 'Thợ Bình']);
    expect(rows[0].cells.FILING).toEqual({
      PENDING: { orders: 0, qty: 0 },
      WORKING: { orders: 1, qty: 3 },
      DONE: { orders: 1, qty: 10 },
      DEFECT: { orders: 1, qty: 1 },
    });
    expect(rows[0].cells.PLATING?.PENDING).toEqual({ orders: 1, qty: 4 });
    // Hai thợ cùng làm đơn o1 ở Nguội: tổng vẫn là 1 đơn, SL cộng cả hai.
    expect(totals.FILING.DONE).toEqual({ orders: 1, qty: 15 });
    expect(totals.ENGRAVING.DONE).toEqual({ orders: 0, qty: 0 });
  });

  it('thợ chưa có việc vẫn có dòng; người ngoài danh sách có việc thì thêm vào', () => {
    const { rows } = workerPerformance(
      [item({ workerId: 'admin', workerName: 'Admin' })],
      [
        { id: 'u2', fullName: 'Thợ Bình', stages: ['PLATING', 'FILING'] },
        { id: 'u1', fullName: 'Thợ An', stages: [] },
      ],
    );
    expect(rows.map((r) => r.workerName)).toEqual([
      'Admin',
      'Thợ An',
      'Thợ Bình',
    ]);
    expect(rows[2]).toMatchObject({
      workerStages: ['FILING', 'PLATING'],
      cells: {},
    });
  });
});

describe('batchCodes / khâu 3D, Sáp, Đúc', () => {
  it('tách mã đơn trong lô đúc', () => {
    expect(batchCodes('DH001, DH002,DH003  DH004')).toEqual([
      'DH001',
      'DH002',
      'DH003',
      'DH004',
    ]);
    expect(batchCodes('')).toEqual([]);
  });

  it('khâu 3D / Sáp / Đúc gom như khâu thợ, xếp đúng thứ tự khâu trên tài khoản', () => {
    const { rows, totals } = workerPerformance(
      [
        {
          orderId: 'o1',
          stage: 'MODEL3D',
          workerId: 'u1',
          workerName: 'Thợ 3D',
          status: 'DONE',
          qty: 2,
        },
        {
          orderId: 'o2',
          stage: 'CASTING',
          workerId: 'u2',
          workerName: 'Thợ đúc',
          status: 'WORKING',
          qty: 4,
        },
      ],
      [{ id: 'u1', fullName: 'Thợ 3D', stages: ['WAX', 'MODEL3D'] }],
    );
    expect(rows[0].workerStages).toEqual(['MODEL3D', 'WAX']);
    expect(rows[0].cells.MODEL3D?.DONE).toEqual({ orders: 1, qty: 2 });
    expect(totals.CASTING.WORKING).toEqual({ orders: 1, qty: 4 });
  });
});

describe('kỳ xem trên màn Tổng quan', () => {
  it('theo ngày: mỗi ngày một mốc', () => {
    expect(overviewBuckets('2026-10-20', '2026-10-22', 'day')).toEqual([
      { key: '2026-10-20', start: '2026-10-20', end: '2026-10-20' },
      { key: '2026-10-21', start: '2026-10-21', end: '2026-10-21' },
      { key: '2026-10-22', start: '2026-10-22', end: '2026-10-22' },
    ]);
  });

  it('theo tuần: mốc từ thứ Hai, mốc đầu / cuối cắt theo kỳ', () => {
    expect(overviewBuckets('2026-10-08', '2026-10-22', 'week')).toEqual([
      { key: '2026-10-05', start: '2026-10-08', end: '2026-10-11' },
      { key: '2026-10-12', start: '2026-10-12', end: '2026-10-18' },
      { key: '2026-10-19', start: '2026-10-19', end: '2026-10-22' },
    ]);
  });

  it('theo tháng: mốc là tháng dương lịch', () => {
    expect(overviewBuckets('2026-08-15', '2026-10-22', 'month')).toEqual([
      { key: '2026-08-01', start: '2026-08-15', end: '2026-08-31' },
      { key: '2026-09-01', start: '2026-09-01', end: '2026-09-30' },
      { key: '2026-10-01', start: '2026-10-01', end: '2026-10-22' },
    ]);
  });

  it('lùi tháng giữ ngày, quá cuối tháng thì về ngày cuối', () => {
    expect(addMonthKey('2026-10-31', -1)).toBe('2026-09-30');
    expect(addMonthKey('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthKey('2026-01-15', -2)).toBe('2025-11-15');
  });

  it('kỳ trước lùi đúng số mốc đang xem', () => {
    expect(previousPeriod('2026-10-16', '2026-10-22', 'day')).toEqual({
      from: '2026-10-09',
      to: '2026-10-15',
    });
    expect(previousPeriod('2026-10-19', '2026-10-22', 'week')).toEqual({
      from: '2026-10-12',
      to: '2026-10-15',
    });
    // Tháng này tới hôm nay so với cùng kỳ tháng trước.
    expect(previousPeriod('2026-10-01', '2026-10-22', 'month')).toEqual({
      from: '2026-09-01',
      to: '2026-09-22',
    });
  });

  it('kỳ trước có cùng số mốc để so từng cặp', () => {
    const prev = previousPeriod('2026-08-15', '2026-10-22', 'month');
    expect(overviewBuckets(prev.from, prev.to, 'month')).toHaveLength(3);
  });

  it('tra mốc theo ngày', () => {
    const index = bucketIndexByDay(
      overviewBuckets('2026-10-08', '2026-10-22', 'week'),
    );
    expect(index.get('2026-10-08')).toBe(0);
    expect(index.get('2026-10-18')).toBe(1);
    expect(index.get('2026-10-22')).toBe(2);
    expect(index.get('2026-10-07')).toBeUndefined();
  });
});
