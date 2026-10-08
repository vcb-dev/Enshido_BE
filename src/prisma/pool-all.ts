/** Giới hạn số query song song — pool Prisma session (Supabase 5432) chỉ ~10 slot. */
export async function poolAll<const A extends readonly (() => Promise<unknown>)[]>(
  tasks: A,
  concurrency = 4,
): Promise<{
  [K in keyof A]: A[K] extends () => Promise<infer R> ? R : never;
}> {
  if (tasks.length === 0) return [] as never;
  const limit = Math.min(Math.max(1, concurrency), tasks.length);
  const results: unknown[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next;
        next += 1;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results as {
    [K in keyof A]: A[K] extends () => Promise<infer R> ? R : never;
  };
}
