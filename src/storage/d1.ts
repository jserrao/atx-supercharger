import type { AppConfig, ChargerObservation, PollStatus, SourceComparison, StationRecord } from "../types";
import { isStale } from "../observations";
import { applyObservationToStation, matchStation } from "./stations";

export type PollRunRow = {
  id: string;
  scheduled_at: string;
  started_at: string;
  completed_at: string | null;
  vehicle_state: string | null;
  source_used: string | null;
  fleet_status: number | null;
  graphql_status: number | null;
  sample_count: number;
  latency_ms: number | null;
  status: string;
  error: string | null;
};

export async function listStations(db: D1Database): Promise<StationRecord[]> {
  const result = await db.prepare("SELECT * FROM stations").all<StationRecord>();
  return result.results ?? [];
}

export async function insertPollRun(
  db: D1Database,
  row: Pick<PollRunRow, "id" | "scheduled_at" | "started_at" | "status">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO poll_runs (id, scheduled_at, started_at, status, sample_count)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(scheduled_at) DO UPDATE SET
         started_at = excluded.started_at,
         status = excluded.status,
         error = NULL`,
    )
    .bind(row.id, row.scheduled_at, row.started_at, row.status)
    .run();
}

export async function getPollRunByScheduledAt(
  db: D1Database,
  scheduledAt: string,
): Promise<PollRunRow | null> {
  return db
    .prepare("SELECT * FROM poll_runs WHERE scheduled_at = ?")
    .bind(scheduledAt)
    .first<PollRunRow>();
}

export async function completePollRun(
  db: D1Database,
  id: string,
  fields: {
    completedAt: string;
    vehicleState: string | null;
    sourceUsed: string | null;
    fleetStatus: number | null;
    graphqlStatus: number | null;
    sampleCount: number;
    latencyMs: number;
    status: PollStatus;
    error: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE poll_runs
       SET completed_at = ?, vehicle_state = ?, source_used = ?, fleet_status = ?,
           graphql_status = ?, sample_count = ?, latency_ms = ?, status = ?, error = ?
       WHERE id = ?`,
    )
    .bind(
      fields.completedAt,
      fields.vehicleState,
      fields.sourceUsed,
      fields.fleetStatus,
      fields.graphqlStatus,
      fields.sampleCount,
      fields.latencyMs,
      fields.status,
      fields.error,
      id,
    )
    .run();
}

export async function upsertStation(db: D1Database, station: StationRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stations (
         id, fleet_id, graphql_id, name, latitude, longitude, total_stalls,
         max_power_kw, hardware_generation, amenities, match_method, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         fleet_id = COALESCE(excluded.fleet_id, stations.fleet_id),
         graphql_id = COALESCE(excluded.graphql_id, stations.graphql_id),
         name = excluded.name,
         total_stalls = COALESCE(excluded.total_stalls, stations.total_stalls),
         max_power_kw = COALESCE(excluded.max_power_kw, stations.max_power_kw),
         hardware_generation = COALESCE(excluded.hardware_generation, stations.hardware_generation),
         amenities = COALESCE(excluded.amenities, stations.amenities),
         match_method = COALESCE(stations.match_method, excluded.match_method),
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      station.id,
      station.fleet_id,
      station.graphql_id,
      station.name,
      station.latitude,
      station.longitude,
      station.total_stalls,
      station.max_power_kw,
      station.hardware_generation,
      station.amenities,
      station.match_method,
      station.first_seen_at,
      station.last_seen_at,
    )
    .run();
}

export async function persistObservations(
  db: D1Database,
  config: AppConfig,
  pollRunId: string,
  scheduledAt: string,
  observations: ChargerObservation[],
): Promise<{ sampleCount: number; stationIds: string[] }> {
  const stations = await listStations(db);
  const stationIds: string[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const observation of observations) {
    const matched = matchStation(stations, observation, config.matchDistanceMeters);
    const method = matched?.method ?? "created";
    const station = applyObservationToStation(
      matched?.existing ?? null,
      observation,
      observation.observedAt,
      method,
    );
    const existingIndex = stations.findIndex((row) => row.id === station.id);
    if (existingIndex >= 0) stations[existingIndex] = station;
    else stations.push(station);

    statements.push(
      db.prepare(
        `INSERT INTO stations (
           id, fleet_id, graphql_id, name, latitude, longitude, total_stalls,
           max_power_kw, hardware_generation, amenities, match_method, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fleet_id = COALESCE(excluded.fleet_id, stations.fleet_id),
           graphql_id = COALESCE(excluded.graphql_id, stations.graphql_id),
           name = excluded.name,
           total_stalls = COALESCE(excluded.total_stalls, stations.total_stalls),
           max_power_kw = COALESCE(excluded.max_power_kw, stations.max_power_kw),
           hardware_generation = COALESCE(excluded.hardware_generation, stations.hardware_generation),
           amenities = COALESCE(excluded.amenities, stations.amenities),
           match_method = COALESCE(stations.match_method, excluded.match_method),
           last_seen_at = excluded.last_seen_at`,
      ).bind(
        station.id,
        station.fleet_id,
        station.graphql_id,
        station.name,
        station.latitude,
        station.longitude,
        station.total_stalls,
        station.max_power_kw,
        station.hardware_generation,
        station.amenities,
        station.match_method,
        station.first_seen_at,
        station.last_seen_at,
      ),
    );

    const stale = isStale(observation.congestionAgeSeconds, config.staleThresholdSeconds) ? 1 : 0;
    statements.push(
      db.prepare(
        `INSERT INTO station_samples (
           poll_run_id, station_id, station_name, source_station_id, scheduled_at, polled_at,
           observed_at, source, available_stalls, total_stalls, occupied_stalls, utilization_pct,
           site_closed, congestion_sync_at, congestion_age_seconds, is_stale, max_power_kw,
           hardware_generation, amenities, billing_info
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(poll_run_id, station_id) DO UPDATE SET
           station_name = excluded.station_name,
           source_station_id = excluded.source_station_id,
           scheduled_at = excluded.scheduled_at,
           polled_at = excluded.polled_at,
           observed_at = excluded.observed_at,
           source = excluded.source,
           available_stalls = excluded.available_stalls,
           total_stalls = excluded.total_stalls,
           occupied_stalls = excluded.occupied_stalls,
           utilization_pct = excluded.utilization_pct,
           site_closed = excluded.site_closed,
           congestion_sync_at = excluded.congestion_sync_at,
           congestion_age_seconds = excluded.congestion_age_seconds,
           is_stale = excluded.is_stale,
           max_power_kw = excluded.max_power_kw,
           hardware_generation = excluded.hardware_generation,
           amenities = excluded.amenities,
           billing_info = excluded.billing_info`,
      ).bind(
        pollRunId,
        station.id,
        observation.name,
        observation.sourceStationId,
        scheduledAt,
        observation.observedAt,
        observation.observedAt,
        observation.source,
        observation.availableStalls,
        observation.totalStalls,
        observation.occupiedStalls,
        observation.utilizationPct,
        observation.siteClosed == null ? null : observation.siteClosed ? 1 : 0,
        observation.congestionSyncAt,
        observation.congestionAgeSeconds,
        stale,
        observation.maxPowerKw,
        observation.hardwareGeneration,
        typeof observation.amenities === "string"
          ? observation.amenities
          : observation.amenities == null
            ? null
            : JSON.stringify(observation.amenities),
        observation.billingInfo,
      ),
    );
    stationIds.push(station.id);
  }

  if (statements.length > 0) await db.batch(statements);
  return { sampleCount: observations.length, stationIds };
}

export async function insertRawResponse(
  db: D1Database,
  pollRunId: string,
  source: string,
  createdAt: string,
  payload: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO raw_responses (poll_run_id, source, created_at, payload)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(pollRunId, source, createdAt, JSON.stringify(payload))
    .run();
}

export async function insertComparisons(
  db: D1Database,
  pollRunId: string,
  createdAt: string,
  comparisons: SourceComparison[],
): Promise<void> {
  if (comparisons.length === 0) return;
  const statements = comparisons.map((row) =>
    db
      .prepare(
        `INSERT INTO source_comparisons (
           poll_run_id, station_id, fleet_available, graphql_available,
           available_delta, congestion_age_delta_seconds, identity_match, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        pollRunId,
        row.stationId,
        row.fleetAvailable,
        row.graphqlAvailable,
        row.availableDelta,
        row.congestionAgeDeltaSeconds,
        row.identityMatch ? 1 : 0,
        createdAt,
      ),
  );
  await db.batch(statements);
}

export async function pruneRawResponses(
  db: D1Database,
  retentionDays: number,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM raw_responses WHERE created_at < ?").bind(cutoff).run();
}

export type HttpErrorCount = {
  source: "fleet" | "graphql";
  httpStatus: number;
  count: number;
};

export type CollectionStats = {
  invocations: number;
  successfulPolls: number;
  fleetPolls: number;
  graphqlPolls: number;
  failedPolls: number;
  offlinePolls: number;
  outOfRegionPolls: number;
  avgLatencyMs: number | null;
  avgStationsPerPoll: number | null;
  avgStationsWhenSampled: number | null;
  firstScheduledAt: string | null;
  last: PollRunRow | null;
  statusCounts: Record<string, number>;
  httpErrors: HttpErrorCount[];
  samples: number;
  staleSamples: number;
};

function round1(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(1));
}

export async function collectionStatsSince(db: D1Database, sinceIso: string): Promise<CollectionStats> {
  const [totals, statuses, fleetErrors, graphqlErrors, sampleCounts, last] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS invocations,
           SUM(CASE WHEN status IN ('success', 'partial_success') THEN 1 ELSE 0 END) AS successful_polls,
           SUM(CASE WHEN source_used = 'fleet' THEN 1 ELSE 0 END) AS fleet_polls,
           SUM(CASE WHEN source_used = 'graphql' THEN 1 ELSE 0 END) AS graphql_polls,
           SUM(CASE WHEN status IN ('fleet_error', 'graphql_error', 'graphql_auth_failure', 'rate_limited', 'not_connected', 'no_data') THEN 1 ELSE 0 END) AS failed_polls,
           SUM(CASE WHEN status = 'fleet_vehicle_offline' THEN 1 ELSE 0 END) AS offline_polls,
           SUM(CASE WHEN status = 'fleet_out_of_region' THEN 1 ELSE 0 END) AS out_of_region_polls,
           AVG(latency_ms) AS avg_latency_ms,
           AVG(sample_count) AS avg_stations_per_poll,
           AVG(CASE WHEN sample_count > 0 THEN sample_count END) AS avg_stations_when_sampled,
           MIN(scheduled_at) AS first_scheduled_at
         FROM poll_runs
         WHERE scheduled_at >= ?`,
      )
      .bind(sinceIso)
      .first<{
        invocations: number;
        successful_polls: number;
        fleet_polls: number;
        graphql_polls: number;
        failed_polls: number;
        offline_polls: number;
        out_of_region_polls: number;
        avg_latency_ms: number | null;
        avg_stations_per_poll: number | null;
        avg_stations_when_sampled: number | null;
        first_scheduled_at: string | null;
      }>(),
    db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM poll_runs WHERE scheduled_at >= ? GROUP BY status`,
      )
      .bind(sinceIso)
      .all<{ status: string; n: number }>(),
    db
      .prepare(
        `SELECT fleet_status AS http_status, COUNT(*) AS n
         FROM poll_runs
         WHERE scheduled_at >= ? AND fleet_status IS NOT NULL AND fleet_status >= 400
         GROUP BY fleet_status`,
      )
      .bind(sinceIso)
      .all<{ http_status: number; n: number }>(),
    db
      .prepare(
        `SELECT graphql_status AS http_status, COUNT(*) AS n
         FROM poll_runs
         WHERE scheduled_at >= ? AND graphql_status IS NOT NULL AND graphql_status >= 400
         GROUP BY graphql_status`,
      )
      .bind(sinceIso)
      .all<{ http_status: number; n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS samples, SUM(CASE WHEN is_stale = 1 THEN 1 ELSE 0 END) AS stale_samples
         FROM station_samples
         WHERE observed_at >= ?`,
      )
      .bind(sinceIso)
      .first<{ samples: number; stale_samples: number }>(),
    db
      .prepare(`SELECT * FROM poll_runs WHERE scheduled_at >= ? ORDER BY scheduled_at DESC LIMIT 1`)
      .bind(sinceIso)
      .first<PollRunRow>(),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of statuses.results ?? []) {
    statusCounts[row.status] = Number(row.n) || 0;
  }

  const httpErrors: HttpErrorCount[] = [
    ...(fleetErrors.results ?? []).map((row) => ({
      source: "fleet" as const,
      httpStatus: Number(row.http_status),
      count: Number(row.n) || 0,
    })),
    ...(graphqlErrors.results ?? []).map((row) => ({
      source: "graphql" as const,
      httpStatus: Number(row.http_status),
      count: Number(row.n) || 0,
    })),
  ];

  return {
    invocations: Number(totals?.invocations) || 0,
    successfulPolls: Number(totals?.successful_polls) || 0,
    fleetPolls: Number(totals?.fleet_polls) || 0,
    graphqlPolls: Number(totals?.graphql_polls) || 0,
    failedPolls: Number(totals?.failed_polls) || 0,
    offlinePolls: Number(totals?.offline_polls) || 0,
    outOfRegionPolls: Number(totals?.out_of_region_polls) || 0,
    avgLatencyMs: round1(totals?.avg_latency_ms),
    avgStationsPerPoll: round1(totals?.avg_stations_per_poll),
    avgStationsWhenSampled: round1(totals?.avg_stations_when_sampled),
    firstScheduledAt: totals?.first_scheduled_at ?? null,
    last: last ?? null,
    statusCounts,
    httpErrors,
    samples: Number(sampleCounts?.samples) || 0,
    staleSamples: Number(sampleCounts?.stale_samples) || 0,
  };
}
