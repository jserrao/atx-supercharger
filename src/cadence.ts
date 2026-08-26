export function cadenceBucket(date: Date, intervalMinutes: number): string {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const bucket = Math.floor(date.getTime() / intervalMs) * intervalMs;
  return new Date(bucket).toISOString();
}

export function expectedBucketsSince(fromIso: string, to: Date, intervalMinutes: number): number {
  const start = Date.parse(fromIso);
  if (!Number.isFinite(start)) return 0;
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const elapsed = to.getTime() - start;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / intervalMs) + 1;
}

export function lockTtlSeconds(intervalMinutes: number): number {
  return Math.max(60, intervalMinutes * 60 - 30);
}
