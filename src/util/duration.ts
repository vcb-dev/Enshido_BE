export function parseDurationMs(
  value: string,
  fallbackMs = 15 * 60 * 1000,
): number {
  const v = value.trim().toLowerCase();
  const m = /^(\d+)([smhd])$/.exec(v);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = m[2];
  const mult =
    unit === 's'
      ? 1000
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : 86_400_000;
  return n * mult;
}
