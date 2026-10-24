import { isWorkerPosition, skillLevelFor } from './staff-positions';

describe('vị trí và bậc tay nghề', () => {
  it('chỉ vị trí thợ mới là thợ', () => {
    expect(isWorkerPosition('worker_filing')).toBe(true);
    expect(isWorkerPosition('warehouse_keeper')).toBe(false);
    expect(isWorkerPosition(null)).toBe(false);
  });

  it('bậc tay nghề giữ khi là thợ, bỏ khi không phải thợ', () => {
    expect(skillLevelFor('worker_polish', 3)).toBe(3);
    expect(skillLevelFor('worker_polish', undefined)).toBeNull();
    expect(skillLevelFor('accountant', 3)).toBeNull();
    expect(skillLevelFor(null, 2)).toBeNull();
  });
});
