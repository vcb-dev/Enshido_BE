import { Prisma } from '@prisma/client';
import {
  entriesOf,
  looseTopUps,
  slowestStage,
  subTicketAvailable,
  subTicketCode,
  subTicketState,
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
      subTicketAvailable(ticket({ qty: 7, silverWeight: dec('700') }), [open], [
        applied(1, '100'),
      ]),
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
      subTicketAvailable(ticket({ qty: 7, silverWeight: dec('750') }), [closed], [
        applied(1, '100'),
        loose(0, '50'),
      ]),
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
