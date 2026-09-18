import { Prisma } from '@prisma/client';
import {
  entriesOf,
  subTicketAvailable,
  subTicketCode,
  subTicketState,
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
