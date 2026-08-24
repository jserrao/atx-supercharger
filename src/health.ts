import { expectedBucketsSince } from "./cadence";
import { graphqlEnabled, loadConfig } from "./config";
import { collectionStatsSince, type CollectionStats } from "./storage/d1";
import { readCollectorMarkers } from "./storage/kv";

export const FAILED_POLL_STATUSES = [
  "fleet_error",
  "graphql_error",
  "graphql_auth_failure",
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
  graphqlOn: boolean;
  bbox: { north: number; south: number; west: number; east: number };
  markers: {
    lastSuccess: string | null;
    lastFleetSuccess: string | null;
    lastGraphqlSuccess: string | null;
  };
}): Record<string, unknown> {
  const scheduled = scheduledPolls(args.windowHours, args.intervalMinutes);
  const elapsed = args.stats.firstScheduledAt
    ? expectedBucketsSince(args.stats.firstScheduledAt, args.now, args.intervalMinutes)
    : 0;
  const last = args.stats.last;

  return {
    service: "atx-supercharger-collector",
    mode: args.mode,
    graphql_enabled: args.graphqlOn,
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
      graphql: args.stats.graphqlPolls,
      failed: args.stats.failedPolls,
      fleet_vehicle_offline: args.stats.offlinePolls,
      fleet_out_of_region: args.stats.outOfRegionPolls,
      avg_latency_ms: args.stats.avgLatencyMs,
      avg_stations_per_poll: args.stats.avgStationsPerPoll,
      avg_stations_when_sampled: args.stats.avgStationsWhenSampled,
      by_status: args.stats.statusCounts,
    },
    api_errors_by_source: {
      fleet: args.stats.httpErrors
        .filter((row) => row.source === "fleet")
        .map((row) => ({ http_status: row.httpStatus, count: row.count })),
      graphql: args.stats.httpErrors
        .filter((row) => row.source === "graphql")
        .map((row) => ({ http_status: row.httpStatus, count: row.count })),
    },
    samples: {
      total: args.stats.samples,
      stale_congestion: args.stats.staleSamples,
      stale_pct: pct(args.stats.staleSamples, args.stats.samples),
    },
    last_success: args.markers.lastSuccess,
    last_fleet_success: args.markers.lastFleetSuccess,
    last_graphql_success: args.markers.lastGraphqlSuccess,
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
          graphql_status: last.graphql_status,
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
  const [stats, markers] = await Promise.all([
    collectionStatsSince(env.DB, sinceIso),
    readCollectorMarkers(env.KV),
  ]);
  return assembleHealth({
    windowHours: hours,
    intervalMinutes: config.collectionIntervalMinutes,
    now,
    sinceIso,
    stats,
    mode: config.collectorMode,
    graphqlOn: graphqlEnabled(config.collectorMode),
    bbox: config.bbox,
    markers,
  });
}
