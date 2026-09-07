/** Share one in-flight promise so concurrent callers hit the DB once. */
export class InflightMap {
  private readonly map = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key);
    if (existing) return existing as Promise<T>;
    const pending = fn().finally(() => {
      if (this.map.get(key) === pending) this.map.delete(key);
    });
    this.map.set(key, pending);
    return pending;
  }
}

export class TtlCache {
  private readonly store = new Map<string, { exp: number; value: unknown }>();

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number) {
    this.store.set(key, { value, exp: Date.now() + ttlMs });
  }

  delete(key: string) {
    this.store.delete(key);
  }
}
