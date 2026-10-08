import { poolAll } from './pool-all';

describe('poolAll', () => {
  it('chạy hết task và giữ thứ tự', async () => {
    const seen: number[] = [];
    const out = await poolAll(
      [
        async () => {
          seen.push(1);
          return 'a';
        },
        async () => {
          seen.push(2);
          return 'b';
        },
        async () => {
          seen.push(3);
          return 'c';
        },
      ],
      2,
    );
    expect(out).toEqual(['a', 'b', 'c']);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('không vượt quá concurrency', async () => {
    let running = 0;
    let max = 0;
    const task = () =>
      new Promise<number>((resolve) => {
        running += 1;
        max = Math.max(max, running);
        setTimeout(() => {
          running -= 1;
          resolve(running);
        }, 20);
      });
    await poolAll([task, task, task, task, task], 2);
    expect(max).toBeLessThanOrEqual(2);
  });
});
