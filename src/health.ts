import { expectedBucketsSince } from "./cadence";
import { googleEnabled, loadConfig } from "./config";
import { collectionStatsSince, type CollectionStats } from "./storage/d1";

export const FAILED_POLL_STATUSES = [
  "fleet_error",
  "google_error",
  "google_auth_failure",
  "google_rate_limited",
  "rate_limited",
  "not_connected",
  "no_data",
] as const;

export function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export function scheduledPolls(windowHours: number, intervalMinutes: number): number {
  return Math.floor((windowHours * 60) / Math.max(1, intervalMinutes));
}

export function coveragePct(successfulPolls: number, scheduledPollsCount: number): number {
  return pct(successfulPolls, scheduledPollsCount);
}

export function assembleHealth(args: {
  windowHours: number;
  intervalMinutes: number;
  now: Date;
  sinceIso: string;
  stats: CollectionStats;
  mode: string;
  googleOn: boolean;
  bbox: { north: number; south: number; west: number; east: number };
}): Record<string, unknown> {
  const scheduled = scheduledPolls(args.windowHours, args.intervalMinutes);
  const elapsed = args.stats.firstScheduledAt
    ? expectedBucketsSince(args.stats.firstScheduledAt, args.now, args.intervalMinutes)
    : 0;
  const last = args.stats.last;

  return {
    service: "atx-supercharger-collector",
    mode: args.mode,
    google_enabled: args.googleOn,
    window: {
      hours: args.windowHours,
      since: args.sinceIso,
      interval_minutes: args.intervalMinutes,
    },
    coverage: {
      scheduled_polls: scheduled,
      elapsed_buckets: elapsed,
      invocations: args.stats.invocations,
      successful_polls: args.stats.successfulPolls,
      coverage_pct: coveragePct(args.stats.successfulPolls, scheduled),
      coverage_elapsed_pct: coveragePct(args.stats.successfulPolls, elapsed),
      invocation_pct: pct(args.stats.invocations, scheduled),
    },
    polls: {
      fleet: args.stats.fleetPolls,
      google: args.stats.googlePolls,
      failed: args.stats.failedPolls,
      fleet_vehicle_offline: args.stats.offlinePolls,
      google_cooldown: args.stats.cooldownPolls,
      fleet_out_of_region: args.stats.outOfRegionPolls,
      avg_latency_ms: args.stats.avgLatencyMs,
      avg_stations_per_poll: args.stats.avgStationsPerPoll,
      avg_stations_when_sampled: args.stats.avgStationsWhenSampled,
      google_requests: args.stats.googleRequests,
      by_status: args.stats.statusCounts,
    },
    api_errors_by_source: {
      fleet: args.stats.httpErrors
        .filter((row) => row.source === "fleet")
        .map((row) => ({ http_status: row.httpStatus, count: row.count })),
      google: args.stats.httpErrors
        .filter((row) => row.source === "google")
        .map((row) => ({ http_status: row.httpStatus, count: row.count })),
    },
    samples: {
      total: args.stats.samples,
      stale_congestion: args.stats.staleSamples,
      stale_pct: pct(args.stats.staleSamples, args.stats.samples),
    },
    last_success: args.stats.lastSuccessAt,
    last_fleet_success: args.stats.lastFleetSuccessAt,
    last_google_success: args.stats.lastGoogleSuccessAt,
    last_poll: last
      ? {
          id: last.id,
          scheduled_at: last.scheduled_at,
          status: last.status,
          sample_count: last.sample_count,
          vehicle_state: last.vehicle_state,
          source_used: last.source_used,
          latency_ms: last.latency_ms,
          fleet_status: last.fleet_status,
          google_status: last.google_status,
          google_requests: last.google_requests,
          error: last.error,
        }
      : null,
    bbox: args.bbox,
  };
}

export async function healthPayload(env: Env, now = new Date(), windowHours = 24): Promise<Record<string, unknown>> {
  const hours = Math.min(168, Math.max(1, windowHours));
  const config = loadConfig(env);
  const sinceIso = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  const stats = await collectionStatsSince(env.DB, sinceIso);
  return assembleHealth({
    windowHours: hours,
    intervalMinutes: config.collectionIntervalMinutes,
    now,
    sinceIso,
    stats,
    mode: config.collectorMode,
    googleOn: googleEnabled(config.collectorMode),
    bbox: config.bbox,
  });
}
