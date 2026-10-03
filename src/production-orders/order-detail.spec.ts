import {
  MaterialRequestStatus,
  Prisma,
  ProductionStatus,
} from '@prisma/client';
import {
  blankLeftOf,
  entriesOf,
  handedStoneOf,
  lastStageDone,
  orderEntries,
  orderListStatuses,
  orderTicketAvailable,
  orderTicketState,
  outcomeStatus,
  recentFirst,
  deriveOrderStatus,
  furthestStatus,
  subTicketAvailable,
  subTicketCode,
  subTicketState,
  subTicketSummary,
  ticketPosition,
  ticketStatus,
  type OrderDetail,
  type StageEntry,
  type SubTicket,
} from './order-detail';

describe('phôi ghi trực tiếp trên lệnh sau đúc', () => {
  it('trừ số phôi đã cấp cho thợ theo chiếc và gram', () => {
    const order = {
      blankQty: 3,
      blankWeight: new Prisma.Decimal('12.5'),
      blankMaterialId: 'blank-material',
      castingCutLines: [],
      materialRequests: [
        {
          status: MaterialRequestStatus.ISSUED,
          materialId: 'blank-material',
          issuedQty: new Prisma.Decimal(1),
          issuedWeight: new Prisma.Decimal('4.5'),
        },
      ],
    };
    expect(blankLeftOf(order)).toEqual({
      btpMaterialId: 'blank-material',
      leftQty: '2',
      leftWeight: '8',
    });
  });
});

const dec = (value: string) => new Prisma.Decimal(value);

/** Khâu tối giản — chỉ các trường mà hàm đang kiểm đọc tới. */
function entry(over: Partial<StageEntry> = {}): StageEntry {
  return {
    id: 'e1',
    subTicketId: 't1',
    stage: 'FILING',
    attempt: 1,
    handedQty: 6,
    handedSilverWeight: dec('600'),
    submittedAt: null,
    returnedAt: null,
    returnedQty: null,
    returnedSilverWeight: null,
    ...over,
  } as StageEntry;
}

function ticket(over: Partial<SubTicket> = {}): SubTicket {
  return {
    id: 't1',
    no: 1,
    qty: 6,
    pendingStage: null,
    claimedByUserId: null,
    outcome: null,
    note: null,
    createdAt: new Date('2026-09-21T02:00:00Z'),
    ...over,
  } as SubTicket;
}

describe('subTicketState — phiếu con đang ở đâu', () => {
  it('chưa mở khâu nào thì rảnh', () => {
    expect(subTicketState(ticket(), [])).toEqual({
      state: 'IDLE',
      activeStage: null,
    });
  });

  it('mở khâu chưa ai nhận: chờ thợ nhận', () => {
    expect(subTicketState(ticket({ pendingStage: 'FILING' }), [])).toEqual({
      state: 'WAITING',
      activeStage: 'FILING',
    });
  });

  it('thợ đã nhận, chờ người giao xác nhận', () => {
    const t = ticket({ pendingStage: 'FILING', claimedByUserId: 'u1' });
    expect(subTicketState(t, [])).toEqual({
      state: 'CLAIMED',
      activeStage: 'FILING',
    });
  });

  it('đã giao, thợ đang làm', () => {
    expect(subTicketState(ticket(), [entry()])).toEqual({
      state: 'WORKING',
      activeStage: 'FILING',
    });
  });

  it('thợ báo xong thì chuyển sang chờ KCS cân lại', () => {
    const open = entry({ submittedAt: new Date('2026-09-19T10:00:00Z') });
    expect(subTicketState(ticket(), [open])).toEqual({
      state: 'SUBMITTED',
      activeStage: 'FILING',
    });
  });

  it('KCS nhận lại xong thì phiếu rảnh trở lại', () => {
    const closed = entry({ returnedAt: new Date(), submittedAt: new Date() });
    expect(subTicketState(ticket(), [closed])).toEqual({
      state: 'IDLE',
      activeStage: null,
    });
  });

  it('kết cục thắng mọi trạng thái khác — phiếu đã chốt thì không còn khâu chạy', () => {
    // Quan trọng: openStage lọc theo state === 'IDLE', nên phiếu đã chốt phải
    // KHÔNG rơi vào IDLE, nếu không sẽ mở được khâu mới cho phiếu đã lỗi.
    const settled = ticket({ outcome: 'DEFECT', pendingStage: 'FILING' });
    expect(subTicketState(settled, [entry()])).toEqual({
      state: 'DEFECT',
      activeStage: null,
    });
    expect(subTicketState(ticket({ outcome: 'FINISH' }), [])).toEqual({
      state: 'FINISH',
      activeStage: null,
    });
  });
});

describe('orderListStatuses — tab theo vị trí thật của từng phiếu', () => {
  it('một đơn xuất hiện ở mọi khâu mà phiếu con đang đứng', () => {
    const statuses = orderListStatuses({
      status: 'FILING',
      subTickets: [ticket({ id: 't1' }), ticket({ id: 't2' })],
      stages: [
        entry({ subTicketId: 't1', stage: 'FILING', returnedAt: new Date() }),
        entry({ id: 'e2', subTicketId: 't2', stage: 'STONE_SETTING' }),
      ],
    });
    // t1 xong Nguội chờ vào đá (L), t2 đang vào đá (N).
    expect(statuses).toEqual(
      expect.arrayContaining(['WAIT_STONE', 'STONE_SETTING']),
    );
  });

  it('phiếu đã chốt nằm ở tab kết cục tương ứng', () => {
    const statuses = orderListStatuses({
      status: 'STONE_SETTING',
      subTickets: [
        ticket({ id: 't1', outcome: 'FINISH' }),
        ticket({ id: 't2', outcome: 'DEFECT' }),
      ],
      stages: [],
    });
    expect(statuses).toEqual(expect.arrayContaining(['FINISHING', 'DEFECT']));
    expect(statuses).not.toContain('STONE_SETTING');
  });

  // `list()` lọc và đếm đơn chưa chia thẳng trong DB bằng chính cột `status`, chỉ kéo đơn
  // đã chia về tính trong bộ nhớ. Luật đó chỉ đúng khi đơn chưa chia luôn nằm đúng một tab.
  it('đơn chưa chia luôn nằm đúng một tab — chính trạng thái của nó', () => {
    for (const status of Object.values(ProductionStatus)) {
      expect(orderListStatuses({ status, subTickets: [], stages: [] })).toEqual(
        [status],
      );
    }
  });
});

describe('recentFirst — trộn phiếu vừa nộp của phiếu mẹ và phiếu con', () => {
  const item = (ticketCode: string, returnedAt: string | null) => ({
    ticketCode,
    returnedAt,
  });

  it('cắt theo thời gian chung, không để một nguồn chiếm hết chỗ', () => {
    // Phiếu mẹ luôn đứng trước trong mảng gộp; nếu cắt mà không trộn thì A002-1 mới hơn
    // vẫn bị đẩy ra để nhường chỗ cho A001 cũ hơn.
    const merged = recentFirst(
      [
        item('A001', '2026-09-20T10:00:00.000Z'),
        item('A003', '2026-09-18T10:00:00.000Z'),
        item('A002-1', '2026-09-22T10:00:00.000Z'),
      ],
      2,
    );
    expect(merged.map((row) => row.ticketCode)).toEqual(['A002-1', 'A001']);
  });

  it('phiếu chưa có mốc nhận lại xếp cuối, mảng gốc không bị đổi', () => {
    const source = [
      item('A001', null),
      item('A002-1', '2026-09-22T10:00:00.000Z'),
    ];
    expect(recentFirst(source, 5).map((row) => row.ticketCode)).toEqual([
      'A002-1',
      'A001',
    ]);
    expect(source.map((row) => row.ticketCode)).toEqual(['A001', 'A002-1']);
  });
});

describe('phiếu mẹ không chia — dùng cùng state machine với phiếu con', () => {
  const parent = (
    pendingStage: 'FILING' | null,
    claimedByUserId: string | null = null,
  ) => ({
    pendingStage,
    claimedByUserId,
    receipt: null,
  });

  it('mở khâu → chờ nhận; thợ nhận → chờ xác nhận giao', () => {
    expect(orderTicketState(parent('FILING'), [])).toEqual({
      state: 'WAITING',
      activeStage: 'FILING',
    });
    expect(orderTicketState(parent('FILING', 'u1'), [])).toEqual({
      state: 'CLAIMED',
      activeStage: 'FILING',
    });
  });

  it('sau khi giao, thợ báo xong thì chuyển sang chờ KCS', () => {
    const working = entry({ subTicketId: null });
    expect(orderTicketState(parent(null), [working]).state).toBe('WORKING');
    expect(
      orderTicketState(parent(null), [
        { ...working, submittedAt: new Date('2026-09-23T03:00:00Z') },
      ]).state,
    ).toBe('SUBMITTED');
  });

  it('chỉ lấy khâu trực tiếp của phiếu mẹ và dùng số KCS trả về cho khâu sau', () => {
    const parentEntry = entry({
      id: 'parent-entry',
      subTicketId: null,
      returnedAt: new Date('2026-09-23T04:00:00Z'),
      returnedQty: 5,
      returnedSilverWeight: dec('590'),
    });
    const childEntry = entry({ id: 'child-entry', subTicketId: 't1' });

    expect(
      orderEntries({ stages: [parentEntry, childEntry] }).map(
        (item) => item.id,
      ),
    ).toEqual(['parent-entry']);
    expect(orderTicketAvailable({ qty: 6 }, [parentEntry])).toEqual({
      qty: 5,
      silver: dec('590'),
    });
  });
});

describe('subTicketAvailable — số lượng / bạc còn lại để giao khâu sau', () => {
  it('chưa làm khâu nào: số lượng là phần đã chia, bạc chưa có — người giao cân lúc giao', () => {
    expect(subTicketAvailable(ticket(), [])).toEqual({
      qty: 6,
      silver: null,
    });
  });

  it('lấy đúng số KCS nhận lại ở khâu gần nhất, không phải số đã giao', () => {
    const closed = entry({
      returnedAt: new Date(),
      returnedQty: 5,
      returnedSilverWeight: dec('596'),
    });
    expect(subTicketAvailable(ticket(), [closed])).toEqual({
      qty: 5,
      silver: dec('596'),
    });
  });

  it('khâu đang làm dở thì lấy số đã giao', () => {
    expect(subTicketAvailable(ticket(), [entry()])).toEqual({
      qty: 6,
      silver: dec('600'),
    });
  });
});

describe('entriesOf', () => {
  it('chỉ lấy khâu của đúng phiếu con, bỏ khâu cấp đơn', () => {
    const stages = [
      entry({ id: 'a', subTicketId: 't1' }),
      entry({ id: 'b', subTicketId: 't2' }),
      entry({ id: 'c', subTicketId: null }),
    ];
    expect(entriesOf({ stages }, 't1').map((e) => e.id)).toEqual(['a']);
  });
});

describe('handedStoneOf — đá phát cho thợ', () => {
  /** Đơn có 600 viên / 480 g đá, chưa giao lần nào. */
  const order = (stages: StageEntry[] = []) => ({
    stoneCount: 600,
    stoneWeight: dec('480'),
    bomLines: [],
    stages,
  });
  const stoneEntry = (id: string, count: number, weight: string) =>
    entry({
      id,
      stage: 'STONE_SETTING',
      handedStoneCount: count,
      handedStoneWeight: dec(weight),
    });

  it('khâu Vào đá nhận cả số viên và TL đá', () => {
    expect(
      handedStoneOf(
        'STONE_SETTING',
        { handedStoneCount: 120, handedStoneWeight: '80' },
        order(),
      ),
    ).toEqual({
      handedStoneCount: 120,
      handedStoneWeight: new Prisma.Decimal('80'),
    });
  });

  it('khâu Vào đá bỏ trống đá thì để null', () => {
    expect(handedStoneOf('STONE_SETTING', {}, order())).toEqual({
      handedStoneCount: null,
      handedStoneWeight: null,
    });
  });

  it('khâu khác không gửi đá thì bỏ qua', () => {
    expect(handedStoneOf('FILING', {}, order())).toEqual({
      handedStoneCount: null,
      handedStoneWeight: null,
    });
  });

  it('khâu khác mà gửi đá lên là sai luồng', () => {
    expect(() =>
      handedStoneOf('FILING', { handedStoneCount: 5 }, order()),
    ).toThrow(/Chỉ khâu Vào đá/);
  });

  it('cộng dồn các phiếu không được vượt số đá của đơn', () => {
    const stages = [stoneEntry('a', 500, '400')];
    expect(() =>
      handedStoneOf('STONE_SETTING', { handedStoneCount: 200 }, order(stages)),
    ).toThrow(/chỉ còn 100 viên/);
    expect(() =>
      handedStoneOf(
        'STONE_SETTING',
        { handedStoneWeight: '100' },
        order(stages),
      ),
    ).toThrow(/chỉ còn 80 g/);
  });

  it('phần còn lại vẫn giao được', () => {
    const stages = [stoneEntry('a', 500, '400')];
    expect(
      handedStoneOf(
        'STONE_SETTING',
        { handedStoneCount: 100, handedStoneWeight: '80' },
        order(stages),
      ),
    ).toEqual({
      handedStoneCount: 100,
      handedStoneWeight: new Prisma.Decimal('80'),
    });
  });

  it('sửa giao: lần đang sửa không tính vào phần đã giao', () => {
    const stages = [stoneEntry('a', 500, '400')];
    expect(
      handedStoneOf(
        'STONE_SETTING',
        { handedStoneCount: 600, handedStoneWeight: '480' },
        order(stages),
        'a',
      ),
    ).toEqual({
      handedStoneCount: 600,
      handedStoneWeight: new Prisma.Decimal('480'),
    });
  });

  it('đơn không ghi đá thì không chặn', () => {
    expect(
      handedStoneOf(
        'STONE_SETTING',
        { handedStoneCount: 999 },
        {
          stoneCount: null,
          stoneWeight: null,
          bomLines: [],
          stages: [],
        },
      ).handedStoneCount,
    ).toBe(999);
  });

  it('đơn nhiều mã NVL: quỹ đá là tổng các dòng', () => {
    const multi = {
      stoneCount: 4,
      stoneWeight: dec('2'),
      bomLines: [
        { qty: 4, stoneWeight: dec('2') },
        { qty: 6, stoneWeight: dec('3') },
      ] as unknown as OrderDetail['bomLines'],
      stages: [],
    };
    expect(
      handedStoneOf(
        'STONE_SETTING',
        { handedStoneCount: 10, handedStoneWeight: '5' },
        multi,
      ).handedStoneCount,
    ).toBe(10);
    expect(() =>
      handedStoneOf('STONE_SETTING', { handedStoneCount: 11 }, multi),
    ).toThrow(/chỉ còn 10 viên/);
  });
});

describe('lastStageDone — đã đi hết tới khâu cuối chưa', () => {
  const RETURNED = new Date('2026-09-21T02:58:00Z');

  it('chưa giao khâu nào thì chưa tới', () => {
    expect(lastStageDone([])).toBe(false);
  });

  it('mới xong Nguội thì chưa tới', () => {
    expect(
      lastStageDone([entry({ stage: 'FILING', returnedAt: RETURNED })]),
    ).toBe(false);
  });

  it('khâu Xi còn đang ở tay thợ thì chưa tới', () => {
    expect(lastStageDone([entry({ stage: 'PLATING' })])).toBe(false);
  });

  it('KCS nhận lại khâu Xi thì tới, dù khâu giữa bị bỏ', () => {
    expect(
      lastStageDone([
        entry({ stage: 'FILING', returnedAt: RETURNED }),
        entry({ stage: 'PLATING', returnedAt: RETURNED }),
      ]),
    ).toBe(true);
  });

  it('xi xong rồi sửa lại nguội thì phải xi lại mới tới', () => {
    expect(
      lastStageDone([
        entry({ stage: 'PLATING', returnedAt: RETURNED }),
        entry({ stage: 'FILING', attempt: 2, returnedAt: RETURNED }),
      ]),
    ).toBe(false);
  });
});

describe('subTicketCode', () => {
  it('ghép mã đơn với số phiếu', () => {
    expect(subTicketCode('A012', 2)).toBe('A012-2');
  });
});

describe('ticketPosition — phiếu con đang đứng ở khâu nào', () => {
  const RETURNED = new Date('2026-09-21T02:58:00Z');

  it('khâu đang chạy: chờ thợ nhận, đang làm', () => {
    expect(ticketPosition(ticket({ pendingStage: 'STONE_SETTING' }), [])).toBe(
      'STONE_SETTING',
    );
    expect(ticketPosition(ticket(), [entry({ stage: 'ENGRAVING' })])).toBe(
      'ENGRAVING',
    );
  });

  it('xong khâu mà chưa mở khâu sau: vẫn tính ở khâu vừa xong', () => {
    // Đúng cảnh A002-1: KCS nhận lại Nguội, phiếu đang rảnh chờ mở Vào đá.
    const done = entry({ stage: 'FILING', returnedAt: RETURNED });
    expect(ticketPosition(ticket(), [done])).toBe('FILING');
  });

  it('chưa làm khâu nào: theo khâu cuối của cả đơn trước lúc chia', () => {
    expect(ticketPosition(ticket(), [], 'FILING')).toBe('FILING');
    expect(ticketPosition(ticket(), [])).toBeNull();
  });

  it('đã chốt Lỗi / Hoàn thiện thì không còn đứng ở khâu nào', () => {
    const done = entry({ stage: 'PLATING', returnedAt: RETURNED });
    expect(ticketPosition(ticket({ outcome: 'FINISH' }), [done])).toBeNull();
    expect(ticketPosition(ticket({ outcome: 'DEFECT' }), [done])).toBeNull();
  });
});

describe('furthestStatus — trạng thái đơn khi phiếu con đi lệch', () => {
  it('lấy phiếu đi xa nhất (tích cực nhất), không theo phiếu chậm', () => {
    expect(furthestStatus(['STONE_SETTING', 'FILING', 'WAIT_FILING'])).toBe(
      'STONE_SETTING',
    );
  });

  it('không phụ thuộc thứ tự phiếu', () => {
    expect(furthestStatus(['ENGRAVING', 'PLATING', 'POLISHING'])).toBe(
      'PLATING',
    );
    expect(furthestStatus(['PLATING', 'ENGRAVING', 'POLISHING'])).toBe(
      'PLATING',
    );
  });

  it('phiếu lỗi xếp thấp nhất: còn phiếu khác chạy thì đơn không báo lỗi', () => {
    expect(furthestStatus(['FILING_DEFECT', 'WAIT_FILING'])).toBe(
      'WAIT_FILING',
    );
    expect(furthestStatus(['FILING_DEFECT', 'STONE_DEFECT'])).not.toBeNull();
  });

  it('bỏ qua phiếu đã chốt kết cục', () => {
    expect(furthestStatus([null, 'WAIT_STONE', null])).toBe('WAIT_STONE');
    expect(furthestStatus([null, null])).toBeNull();
    expect(furthestStatus([])).toBeNull();
  });
});

describe('ticketStatus — I/K/L/N/O của phiếu con', () => {
  const DONE = new Date('2026-09-21T02:58:00Z');

  it('chưa làm khâu nào là Chờ nguội (I)', () => {
    expect(ticketStatus(ticket(), [])).toBe('WAIT_FILING');
  });

  it('khâu mở chờ thợ là "Chờ", thợ đang làm là "Đang"', () => {
    expect(ticketStatus(ticket({ pendingStage: 'FILING' }), [])).toBe(
      'WAIT_FILING',
    );
    expect(ticketStatus(ticket({ pendingStage: 'STONE_SETTING' }), [])).toBe(
      'WAIT_STONE',
    );
    expect(ticketStatus(ticket(), [entry({ stage: 'FILING' })])).toBe('FILING');
    expect(
      ticketStatus(ticket(), [entry({ stage: 'FILING', submittedAt: DONE })]),
    ).toBe('FILING');
    expect(ticketStatus(ticket(), [entry({ stage: 'STONE_SETTING' })])).toBe(
      'STONE_SETTING',
    );
  });

  it('KCS nhận lại xong thì sang Chờ khâu kế: Nguội → L, Vào đá → O', () => {
    expect(
      ticketStatus(ticket(), [entry({ stage: 'FILING', returnedAt: DONE })]),
    ).toBe('WAIT_STONE');
    expect(
      ticketStatus(ticket(), [
        entry({ stage: 'FILING', returnedAt: DONE }),
        entry({ stage: 'STONE_SETTING', returnedAt: DONE }),
      ]),
    ).toBe('WAIT_ENGRAVING');
  });

  it('đơn không có đá: Nguội xong đi thẳng Chờ khắc (O)', () => {
    expect(
      ticketStatus(
        ticket(),
        [entry({ stage: 'FILING', returnedAt: DONE })],
        null,
        true,
      ),
    ).toBe('WAIT_ENGRAVING');
  });

  it('các khâu sau Khắc giữ trạng thái khâu', () => {
    expect(
      ticketStatus(ticket(), [entry({ stage: 'POLISHING', returnedAt: DONE })]),
    ).toBe('POLISHING');
  });

  it('KCS đã nhận nhưng thủ kho chưa xác nhận: vẫn "Đang" khâu đó, chưa sang L', () => {
    const waiting = entry({
      stage: 'FILING',
      returnedAt: DONE,
      confirmedAt: null,
    });
    expect(subTicketState(ticket(), [waiting]).state).toBe('CONFIRMING');
    expect(ticketStatus(ticket(), [waiting])).toBe('FILING');
    const confirmed = entry({
      stage: 'FILING',
      returnedAt: DONE,
      confirmedAt: DONE,
    });
    expect(subTicketState(ticket(), [confirmed]).state).toBe('IDLE');
    expect(ticketStatus(ticket(), [confirmed])).toBe('WAIT_STONE');
  });

  it('báo lỗi ở khâu đang làm: coi như đã nộp cho KCS cân lại', () => {
    const flagged = entry({ stage: 'FILING', defectReportedAt: DONE });
    expect(subTicketState(ticket(), [flagged]).state).toBe('SUBMITTED');
    expect(subTicketState(ticket(), [entry({ stage: 'FILING' })]).state).toBe(
      'WORKING',
    );
  });

  it('lỗi 100% ở Nguội / Vào đá có trạng thái lỗi riêng', () => {
    expect(outcomeStatus({ outcome: 'DEFECT', outcomeStage: 'FILING' })).toBe(
      'FILING_DEFECT',
    );
    expect(
      outcomeStatus({ outcome: 'DEFECT', outcomeStage: 'STONE_SETTING' }),
    ).toBe('STONE_DEFECT');
    expect(outcomeStatus({ outcome: 'DEFECT', outcomeStage: 'PLATING' })).toBe(
      'DEFECT',
    );
    expect(outcomeStatus({ outcome: 'FINISH', outcomeStage: 'PLATING' })).toBe(
      'FINISHING',
    );
  });

  it('phiếu đã chốt kết cục thì không có trạng thái khâu', () => {
    expect(ticketStatus(ticket({ outcome: 'DEFECT' }), [])).toBeNull();
  });
});

describe('deriveOrderStatus', () => {
  const DONE = new Date('2026-09-21T02:58:00Z');
  const base = {
    pendingStage: null,
    claimedByUserId: null,
  } as const;

  it('đơn chưa chia theo khâu của chính nó', () => {
    expect(
      deriveOrderStatus({
        ...base,
        status: ProductionStatus.WAIT_FILING,
        subTickets: [],
        stages: [entry({ stage: 'FILING', subTicketId: null })],
      }),
    ).toBe('FILING');
  });

  it('đơn nhiều phiếu theo phiếu đi xa nhất', () => {
    const t1 = ticket({ id: 't1' });
    const t2 = ticket({ id: 't2' });
    expect(
      deriveOrderStatus({
        ...base,
        status: ProductionStatus.FILING,
        subTickets: [t1, t2],
        stages: [
          entry({ stage: 'FILING', subTicketId: 't1', returnedAt: DONE }),
          entry({ stage: 'FILING', subTicketId: 't2' }),
        ],
      }),
    ).toBe('WAIT_STONE');
  });

  it('giữ nguyên trạng thái ngoài các khâu (Đúc, Lỗi, Hoàn thiện…)', () => {
    for (const status of [
      ProductionStatus.CASTING,
      ProductionStatus.DEFECT,
      ProductionStatus.FINISHING,
    ]) {
      expect(
        deriveOrderStatus({ ...base, status, subTickets: [], stages: [] }),
      ).toBe(status);
    }
  });

  it('mọi phiếu đã có kết cục thì giữ nguyên cho syncOrder xử lý', () => {
    expect(
      deriveOrderStatus({
        ...base,
        status: ProductionStatus.PLATING,
        subTickets: [ticket({ id: 't1', outcome: 'FINISH' })],
        stages: [],
      }),
    ).toBe('PLATING');
  });
});

describe('subTicketSummary — cột Phiếu con ở danh sách đơn', () => {
  const RETURNED = new Date('2026-09-21T02:58:00Z');
  const nguoiDone = entry({
    stage: 'FILING',
    returnedAt: RETURNED,
    craftsmanName: 'Vũ Đại Lương',
  });

  it('chờ thợ nhận khâu mới: khâu mới, chưa có thợ — không mang tên thợ khâu trước', () => {
    const s = subTicketSummary(
      'A001',
      ticket({ pendingStage: 'STONE_SETTING' }),
      [nguoiDone],
    );
    expect(s).toEqual({
      code: 'A001-1',
      no: 1,
      qty: 6,
      note: null,
      createdAt: '2026-09-21T02:00:00.000Z',
      state: 'WAITING',
      status: 'WAIT_STONE',
      stage: 'STONE_SETTING',
      workerName: null,
    });
  });

  it('đã nhận: tên người nhận', () => {
    const s = subTicketSummary(
      'A001',
      ticket({
        pendingStage: 'STONE_SETTING',
        claimedByUserId: 'u2',
        claimedByName: 'Thuỳ Linh',
      }),
      [nguoiDone],
    );
    expect(s.state).toBe('CLAIMED');
    expect(s.workerName).toBe('Thuỳ Linh');
  });

  it('đang làm / đã báo xong: thợ của khâu đang mở', () => {
    const working = entry({
      stage: 'STONE_SETTING',
      craftsmanName: 'Admin Enshido',
    });
    expect(
      subTicketSummary('A001', ticket(), [nguoiDone, working]),
    ).toMatchObject({
      state: 'WORKING',
      stage: 'STONE_SETTING',
      workerName: 'Admin Enshido',
    });
    const submitted = { ...working, submittedAt: RETURNED } as StageEntry;
    expect(
      subTicketSummary('A001', ticket(), [nguoiDone, submitted]).state,
    ).toBe('SUBMITTED');
  });

  it('xong khâu, chưa mở khâu sau: khâu vừa xong, không ai giữ hàng', () => {
    expect(subTicketSummary('A001', ticket(), [nguoiDone])).toMatchObject({
      state: 'IDLE',
      stage: 'FILING',
      workerName: null,
    });
  });

  it('chưa giao khâu nào: không có khâu', () => {
    expect(subTicketSummary('A001', ticket(), [])).toMatchObject({
      state: 'IDLE',
      stage: null,
    });
  });

  it('đã chốt Hoàn thiện: vẫn cho biết khâu cuối', () => {
    const xi = entry({
      stage: 'PLATING',
      returnedAt: RETURNED,
    });
    expect(
      subTicketSummary('A001', ticket({ outcome: 'FINISH' }), [nguoiDone, xi]),
    ).toMatchObject({ state: 'FINISH', stage: 'PLATING', workerName: null });
  });
});
