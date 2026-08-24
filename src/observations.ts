import type { BoundingBox, ChargerObservation } from "./types";
    import { inBbox } from "./geo";

export function occupancyFromStalls(
  available: number | null,
  total: number | null,
): { occupiedStalls: number | null; utilizationPct: number | null } {
  if (available == null || total == null || total <= 0 || available < 0) {
    return { occupiedStalls: null, utilizationPct: null };
  }
  const occupiedStalls = Math.max(0, total - available);
  return {
    occupiedStalls,
    utilizationPct: (occupiedStalls / total) * 100,
  };
}

export function congestionAgeSeconds(
  observedAt: string,
  congestionSyncAt: string | null,
): number | null {
  if (!congestionSyncAt) return null;
  const observed = Date.parse(observedAt);
  const synced = Date.parse(congestionSyncAt);
  if (!Number.isFinite(observed) || !Number.isFinite(synced)) return null;
  return Math.max(0, Math.round((observed - synced) / 1000));
}

export function isStale(
  ageSeconds: number | null,
  thresholdSeconds: number,
): boolean {
  if (ageSeconds == null) return false;
  return ageSeconds > thresholdSeconds;
}

export function unixSecondsToIso(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString();
}

export function asFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function filterToBbox(
  observations: ChargerObservation[],
  bbox: BoundingBox,
): ChargerObservation[] {
  return observations.filter((obs) => inBbox(obs.latitude, obs.longitude, bbox));
}
