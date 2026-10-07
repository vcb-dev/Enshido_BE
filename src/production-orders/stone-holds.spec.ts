import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { planEarlyReturn, planStoneReturn } from './stone-holds';

const dec = (value: string) => new Prisma.Decimal(value);

/** Dòng giữ chỗ tối thiểu cho QC cân gói thừa. */
const hold = (
  id: string,
  materialId: string,
  stoneCount: number,
  weight: string | null,
) => ({
  id,
  materialId,
  stoneCount,
  weight: weight != null ? dec(weight) : null,
  material: { name: materialId },
});

describe('planStoneReturn — QC cân gói đá thừa theo mã', () => {
  // Cấp lúc chỉ định 100 viên A (2 g); thợ xin thêm 20 viên B (0,4 g) rồi 50 viên A (1 g).
  const holds = [
    hold('a1', 'A', 100, '2'),
    hold('b1', 'B', 20, '0.4'),
    hold('a2', 'A', 50, '1'),
  ];

  it('mỗi mã quy viên thừa theo tỷ lệ TL của đúng mã đó', () => {
    const plan = planStoneReturn(
      holds,
      [{ materialId: 'B', weight: '0.3' }],
      null,
    );
    expect(plan.updates.find((item) => item.id === 'b1')).toMatchObject({
      returnedCount: 15,
    });
    expect(plan.updates.find((item) => item.id === 'a1')?.returnedCount).toBe(
      0,
    );
    expect(plan.returnedStoneCount).toBe(15);
    expect(plan.returnedWeight.toString()).toBe('0.3');
  });

  it('cùng mã cấp nhiều lần: trừ gói thừa vào lần cấp cuối trước', () => {
    const plan = planStoneReturn(
      holds,
      [{ materialId: 'A', weight: '1.5' }],
      null,
    );
    const byId = new Map(plan.updates.map((item) => [item.id, item]));
    expect(byId.get('a2')?.returnedWeight?.toString()).toBe('1');
    expect(byId.get('a2')?.returnedCount).toBe(50);
    expect(byId.get('a1')?.returnedWeight?.toString()).toBe('0.5');
    expect(byId.get('a1')?.returnedCount).toBe(25);
  });

  it('QC đếm số viên thừa thì dùng đúng số đó, không suy theo TL', () => {
    const plan = planStoneReturn(
      holds,
      [{ materialId: 'B', weight: '0.3', count: 12 }],
      null,
    );
    expect(plan.updates.find((item) => item.id === 'b1')?.returnedCount).toBe(
      12,
    );
    expect(plan.returnedStoneCount).toBe(12);
  });

  it('cùng mã cấp nhiều lần: số viên đếm chia theo TL thừa từng lần cấp', () => {
    const plan = planStoneReturn(
      holds,
      [{ materialId: 'A', weight: '1.5', count: 70 }],
      null,
    );
    const byId = new Map(plan.updates.map((item) => [item.id, item]));
    // a2 thừa 1 g / 1,5 g, a1 thừa 0,5 g / 1,5 g — a2 đầy ở 50 viên, phần dư dồn sang a1.
    expect(byId.get('a2')?.returnedCount).toBe(47);
    expect(byId.get('a1')?.returnedCount).toBe(23);
    expect(plan.returnedStoneCount).toBe(70);
  });

  it('chặn số viên thừa quá số cấp, hoặc có viên thừa mà không cân gói', () => {
    expect(() =>
      planStoneReturn(
        holds,
        [{ materialId: 'B', weight: '0.1', count: 21 }],
        null,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      planStoneReturn(
        holds,
        [{ materialId: 'B', weight: '0', count: 3 }],
        null,
      ),
    ).toThrow(BadRequestException);
  });

  it('chặn gói thừa nặng hơn TL đã cấp, mã không cấp, mã nhập hai lần', () => {
    expect(() =>
      planStoneReturn(holds, [{ materialId: 'B', weight: '0.5' }], null),
    ).toThrow(BadRequestException);
    expect(() =>
      planStoneReturn(holds, [{ materialId: 'C', weight: '0.1' }], null),
    ).toThrow(BadRequestException);
    expect(() =>
      planStoneReturn(
        holds,
        [
          { materialId: 'A', weight: '0.1' },
          { materialId: 'A', weight: '0.1' },
        ],
        null,
      ),
    ).toThrow(BadRequestException);
  });

  it('dòng cấp cũ không cân gói thì dùng số viên QC đếm; đã cân hết thì không nhận số viên', () => {
    const mixed = [hold('old', 'A', 40, null), hold('new', 'B', 20, '0.4')];
    const plan = planStoneReturn(mixed, [], 10);
    expect(plan.updates.find((item) => item.id === 'old')).toMatchObject({
      returnedWeight: null,
      returnedCount: 10,
    });
    expect(() => planStoneReturn(holds, [], 5)).toThrow(BadRequestException);
  });
});

describe('planEarlyReturn — thợ trả túi đá giữa khâu (đổi size)', () => {
  const pack = (
    id: string,
    qty: string,
    count: number | null,
    weight: string,
  ) => ({
    ...hold(id, 'A', count ?? 0, weight),
    stoneCount: count,
    qty: dec(qty),
  });

  it('trả cả túi thì dòng giữ chỗ về 0', () => {
    const [item] = planEarlyReturn(
      [pack('a', '100', 100, '2')],
      dec('2'),
      true,
    );
    expect(item.qty.toString()).toBe('0');
    expect(item.weight.toString()).toBe('0');
    expect(item.returnedCount).toBe(100);
  });

  it('trả một phần: thu nhỏ theo tỷ lệ TL, trừ vào túi cấp cuối trước', () => {
    const plan = planEarlyReturn(
      [pack('a', '100', 100, '2'), pack('b', '50', 50, '1')],
      dec('1.5'),
      true,
    );
    const byId = new Map(plan.map((item) => [item.hold.id, item]));
    expect(byId.get('b')?.qty.toString()).toBe('0');
    expect(byId.get('a')?.qty.toString()).toBe('75');
    expect(byId.get('a')?.weight.toString()).toBe('1.5');
  });

  it('đá tấm tính theo ct không đếm viên vẫn trả được theo TL', () => {
    // Túi 10 ct (2 g), trả 0,5 g → còn 7,5 ct.
    const [item] = planEarlyReturn(
      [pack('a', '10', null, '2')],
      dec('0.5'),
      false,
    );
    expect(item.qty.toString()).toBe('7.5');
    expect(item.stoneCount).toBeNull();
    expect(item.returnedCount).toBeNull();
  });

  it('chặn trả nặng hơn TL đang giữ', () => {
    expect(() =>
      planEarlyReturn([pack('a', '10', 10, '1')], dec('1.2'), true),
    ).toThrow(BadRequestException);
  });
});

describe('planStoneReturn — đá không đếm viên', () => {
  it('không có số viên thì số viên trả để trống, vẫn ghi TL thừa', () => {
    const plan = planStoneReturn(
      [{ ...hold('a', 'A', 0, '2'), stoneCount: null }],
      [{ materialId: 'A', weight: '0.5' }],
      null,
    );
    expect(plan.returnedStoneCount).toBeNull();
    expect(plan.updates[0].returnedWeight?.toString()).toBe('0.5');
  });
});
