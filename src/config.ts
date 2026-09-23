import type { AppConfig, CollectorMode } from "./types";

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mode(value: string | undefined): CollectorMode {
  if (value === "auto" || value === "dual" || value === "fleet_only") return value;
  return "fleet_only";
}

function flag(value: string | undefined, fallback = false): boolean {
  if (value == null || String(value).trim() === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function hour(value: string | undefined, fallback: number): number {
  const parsed = Math.trunc(num(value, fallback));
  if (parsed < 0 || parsed > 23) return fallback;
  return parsed;
}

export function loadConfig(env: Env): AppConfig {
  return {
    collectionIntervalMinutes: Math.max(1, num(env.COLLECTION_INTERVAL_MINUTES, 5)),
    bbox: {
      north: num(env.BBOX_NORTH, 30.5),
      south: num(env.BBOX_SOUTH, 30.0),
      west: num(env.BBOX_WEST, -98.25),
      east: num(env.BBOX_EAST, -97.7),
    },
    fleetCount: Math.max(1, num(env.FLEET_COUNT, 50)),
    fleetRadius: Math.max(1, num(env.FLEET_RADIUS, 80)),
    staleThresholdSeconds: Math.max(0, num(env.STALE_THRESHOLD_SECONDS, 900)),
    matchDistanceMeters: Math.max(1, num(env.MATCH_DISTANCE_METERS, 150)),
    rawRetentionDays: Math.max(1, num(env.RAW_RETENTION_DAYS, 14)),
    collectorMode: mode(env.COLLECTOR_MODE),
    googleFallbackMinutes: Math.max(1, num(env.GOOGLE_FALLBACK_MINUTES, 60)),
    googleDiscovery: flag(env.GOOGLE_DISCOVERY),
    googlePlacesApiKey: String(env.GOOGLE_MAPS_API_KEY ?? "").trim(),
    teslaAudience: env.TESLA_AUDIENCE,
    teslaRedirectUri: env.TESLA_REDIRECT_URI,
    teslaVin: String(env.TESLA_VIN ?? "").trim(),
    teslaClientId: env.TESLA_CLIENT_ID,
    teslaClientSecret: env.TESLA_CLIENT_SECRET,
    teslaPublicKey: env.TESLA_PUBLIC_KEY,
    adminToken: env.COLLECTOR_ADMIN_TOKEN,
    wakeWhenAsleep: flag(env.WAKE_WHEN_ASLEEP, true),
    wakeTimezone: String(env.WAKE_TIMEZONE ?? "America/Chicago").trim() || "America/Chicago",
    wakeStartHour: hour(env.WAKE_START_HOUR, 8),
    wakeEndHour: hour(env.WAKE_END_HOUR, 15),
    wakeTimeoutSeconds: Math.min(60, Math.max(10, num(env.WAKE_TIMEOUT_SECONDS, 48))),
    wakePollSeconds: Math.min(20, Math.max(2, num(env.WAKE_POLL_SECONDS, 8))),
  };
}

export function googleEnabled(mode: CollectorMode): boolean {
  return mode === "auto" || mode === "dual";
}
