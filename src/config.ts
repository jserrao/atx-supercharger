import type { AppConfig, CollectorMode } from "./types";

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mode(value: string | undefined): CollectorMode {
  if (value === "auto" || value === "dual" || value === "fleet_only") return value;
  return "fleet_only";
}

function flag(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
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
  };
}

export function googleEnabled(mode: CollectorMode): boolean {
  return mode === "auto" || mode === "dual";
}
