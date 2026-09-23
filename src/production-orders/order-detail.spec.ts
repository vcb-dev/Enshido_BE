import { Prisma } from '@prisma/client';
import {
  entriesOf,
  handedStoneOf,
  lastStageDone,
  looseTopUps,
  orderEntries,
  orderTicketAvailable,
  orderTicketState,
  slowestStage,
  subTicketAvailable,
  subTicketCode,
  subTicketState,
  subTicketSummary,
  ticketPosition,
  type StageEntry,
  type SubTicket,
} from './order-detail';

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
    silverWeight: dec('600'),
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

describe('phiếu mẹ không chia — dùng cùng state machine với phiếu con', () => {
  const parent = (pendingStage: 'FILING' | null, claimedByUserId: string | null = null) => ({
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

    expect(orderEntries({ stages: [parentEntry, childEntry] }).map((item) => item.id)).toEqual([
      'parent-entry',
    ]);
    expect(
      orderTicketAvailable({ qty: 6, silverWeight: dec('600') }, [parentEntry]),
    ).toEqual({ qty: 5, silver: dec('590') });
  });
});

describe('subTicketAvailable — số lượng / bạc còn lại để giao khâu sau', () => {
  it('chưa làm khâu nào thì là phần đã chia', () => {
    expect(subTicketAvailable(ticket(), [])).toEqual({
      qty: 6,
      silver: dec('600'),
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

describe('cấp thêm cho phiếu con', () => {
  const loose = (qty: number, silver: string) => ({
    stageEntryId: null,
    qty,
    silverWeight: dec(silver),
  });
  const applied = (qty: number, silver: string) => ({
    stageEntryId: 'e1',
    qty,
    silverWeight: dec(silver),
  });

  it('chỉ cộng phần chưa vào khâu nào', () => {
    expect(looseTopUps([loose(1, '100'), applied(2, '200')])).toEqual({
      qty: 1,
      silver: dec('100'),
    });
  });

  it('cấp thêm khi chưa làm khâu nào: đã nằm trong phần đã chia, KHÔNG cộng lần nữa', () => {
    // ticket.qty được service cộng lên ngay khi cấp thêm, nên cộng tiếp là đếm trùng.
    const t = ticket({ qty: 7, silverWeight: dec('700') });
    expect(subTicketAvailable(t, [], [loose(1, '100')])).toEqual({
      qty: 7,
      silver: dec('700'),
    });
  });

  it('cấp thêm giữa lúc thợ đang làm: đã cộng vào số giao của khâu', () => {
    // Bắt buộc phải vậy, nếu không hao hụt = giao − nhận lại sẽ ra số âm.
    const open = entry({ handedQty: 7, handedSilverWeight: dec('700') });
    expect(
      subTicketAvailable(
        ticket({ qty: 7, silverWeight: dec('700') }),
        [open],
        [applied(1, '100')],
      ),
    ).toEqual({ qty: 7, silver: dec('700') });
  });

  it('cấp thêm sau khi KCS nhận lại: cộng vào số đang có để giao khâu sau', () => {
    const closed = entry({
      returnedAt: new Date(),
      returnedQty: 7,
      returnedSilverWeight: dec('690'),
    });
    // Hao hụt 10 g ở khâu trước vẫn mất, phần cấp thêm 50 g cộng lên trên đó.
    expect(
      subTicketAvailable(
        ticket({ qty: 7, silverWeight: dec('750') }),
        [closed],
        [applied(1, '100'), loose(0, '50')],
      ),
    ).toEqual({ qty: 7, silver: dec('740') });
  });

  it('không có lần cấp thêm nào thì kết quả như cũ', () => {
    const closed = entry({
      returnedAt: new Date(),
      returnedQty: 5,
      returnedSilverWeight: dec('596'),
    });
    expect(subTicketAvailable(ticket(), [closed], [])).toEqual({
      qty: 5,
      silver: dec('596'),
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
      handedStoneOf('STONE_SETTING', { handedStoneWeight: '100' }, order(stages)),
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
        { stoneCount: null, stoneWeight: null, stages: [] },
      ).handedStoneCount,
    ).toBe(999);
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

describe('slowestStage — trạng thái đơn khi phiếu con đi lệch khâu', () => {
  it('lấy khâu của phần chậm nhất, không theo phiếu nhanh', () => {
    // A002-1 đã sang Vào đá, A002-2 / A002-3 còn Nguội → đơn vẫn là Nguội.
    expect(slowestStage(['STONE_SETTING', 'FILING', 'FILING'])).toBe('FILING');
  });

  it('không phụ thuộc thứ tự phiếu', () => {
    expect(slowestStage(['PLATING', 'ENGRAVING', 'POLISHING'])).toBe(
      'ENGRAVING',
    );
    expect(slowestStage(['ENGRAVING', 'PLATING', 'POLISHING'])).toBe(
      'ENGRAVING',
    );
  });

  it('bỏ qua phiếu không đứng ở khâu nào (đã chốt kết cục)', () => {
    expect(slowestStage([null, 'POLISHING', null])).toBe('POLISHING');
    expect(slowestStage([null, null])).toBeNull();
    expect(slowestStage([])).toBeNull();
  });

  it('phần chậm nhất bắt kịp thì đơn mới tiến lên', () => {
    // A002-2, A002-3 xong Nguội và được giao Vào đá — giờ cả đơn đã tới Vào đá.
    expect(
      slowestStage(['STONE_SETTING', 'STONE_SETTING', 'STONE_SETTING']),
    ).toBe('STONE_SETTING');
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
      silverWeight: '600',
      note: null,
      createdAt: '2026-09-21T02:00:00.000Z',
      state: 'WAITING',
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
