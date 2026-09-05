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
