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
  google_status: number | null;
  google_requests: number | null;
  sample_count: number;
  latency_ms: number | null;
  status: string;
  error: string | null;
};

const STATION_COLUMNS = `id, fleet_id, graphql_id, google_place_id, name, latitude, longitude, total_stalls,
         max_power_kw, hardware_generation, amenities, match_method, first_seen_at, last_seen_at`;

function bindStation(db: D1Database, station: StationRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO stations (
         ${STATION_COLUMNS}
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         fleet_id = COALESCE(excluded.fleet_id, stations.fleet_id),
         graphql_id = COALESCE(excluded.graphql_id, stations.graphql_id),
         google_place_id = COALESCE(excluded.google_place_id, stations.google_place_id),
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
      station.google_place_id,
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
    );
}

export async function listStations(db: D1Database): Promise<StationRecord[]> {
  const result = await db.prepare("SELECT * FROM stations").all<StationRecord>();
  return result.results ?? [];
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

export async function claimPollRun(
  db: D1Database,
  row: { id: string; scheduled_at: string; started_at: string; status: string },
  options: { force: boolean; lockTtlSeconds: number; now: Date },
): Promise<{ id: string; skipped: "bucket_already_completed" | "lock_held" | null }> {
  const existing = await getPollRunByScheduledAt(db, row.scheduled_at);
  if (existing?.completed_at && !options.force) {
    return { id: existing.id, skipped: "bucket_already_completed" };
  }
  if (existing && !existing.completed_at && !options.force) {
    const started = Date.parse(existing.started_at);
    if (
      Number.isFinite(started) &&
      options.now.getTime() - started < options.lockTtlSeconds * 1000
    ) {
      return { id: existing.id, skipped: "lock_held" };
    }
  }

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO poll_runs (id, scheduled_at, started_at, status, sample_count, google_requests)
         VALUES (?, ?, ?, ?, 0, 0)
         ON CONFLICT(scheduled_at) DO NOTHING`,
      )
      .bind(row.id, row.scheduled_at, row.started_at, row.status)
      .run();
    const persisted = await getPollRunByScheduledAt(db, row.scheduled_at);
    if (!persisted) return { id: row.id, skipped: "lock_held" };
    if (persisted.id !== row.id && persisted.completed_at && !options.force) {
      return { id: persisted.id, skipped: "bucket_already_completed" };
    }
    if (persisted.id !== row.id && !options.force) {
      return { id: persisted.id, skipped: "lock_held" };
    }
    return { id: persisted.id, skipped: null };
  }

  await db
    .prepare(
      `UPDATE poll_runs
       SET started_at = ?, status = ?, error = NULL, completed_at = NULL
       WHERE scheduled_at = ?`,
    )
    .bind(row.started_at, row.status, row.scheduled_at)
    .run();
  return { id: existing.id, skipped: null };
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
    googleStatus: number | null;
    googleRequests: number;
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
           graphql_status = ?, google_status = ?, google_requests = ?, sample_count = ?,
           latency_ms = ?, status = ?, error = ?
       WHERE id = ?`,
    )
    .bind(
      fields.completedAt,
      fields.vehicleState,
      fields.sourceUsed,
      fields.fleetStatus,
      fields.graphqlStatus,
      fields.googleStatus,
      fields.googleRequests,
      fields.sampleCount,
      fields.latencyMs,
      fields.status,
      fields.error,
      id,
    )
    .run();
}

export async function lastGoogleAttemptAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT started_at FROM poll_runs
       WHERE google_requests > 0
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .first<{ started_at: string }>();
  return row?.started_at ?? null;
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
    if (!matched && observation.source === "google" && !config.googleDiscovery) {
      continue;
    }
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

    statements.push(bindStation(db, station));

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
  return { sampleCount: stationIds.length, stationIds };
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
           poll_run_id, station_id, fleet_available, graphql_available, google_available,
           available_delta, congestion_age_delta_seconds, identity_match, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        pollRunId,
        row.stationId,
        row.fleetAvailable,
        null,
        row.googleAvailable,
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
  source: "fleet" | "google";
  httpStatus: number;
  count: number;
};

export type CollectionStats = {
  invocations: number;
  successfulPolls: number;
  fleetPolls: number;
  googlePolls: number;
  failedPolls: number;
  offlinePolls: number;
  cooldownPolls: number;
  outOfRegionPolls: number;
  avgLatencyMs: number | null;
  avgStationsPerPoll: number | null;
  avgStationsWhenSampled: number | null;
  googleRequests: number;
  firstScheduledAt: string | null;
  lastSuccessAt: string | null;
  lastFleetSuccessAt: string | null;
  lastGoogleSuccessAt: string | null;
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
  const [totals, statuses, fleetErrors, googleErrors, sampleCounts, last] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS invocations,
           SUM(CASE WHEN status IN ('success', 'partial_success') THEN 1 ELSE 0 END) AS successful_polls,
           SUM(CASE WHEN source_used = 'fleet' THEN 1 ELSE 0 END) AS fleet_polls,
           SUM(CASE WHEN source_used = 'google' THEN 1 ELSE 0 END) AS google_polls,
           SUM(CASE WHEN status IN ('fleet_error', 'google_error', 'google_auth_failure', 'google_rate_limited', 'rate_limited', 'not_connected', 'no_data') THEN 1 ELSE 0 END) AS failed_polls,
           SUM(CASE WHEN status = 'fleet_vehicle_offline' THEN 1 ELSE 0 END) AS offline_polls,
           SUM(CASE WHEN status = 'google_cooldown' THEN 1 ELSE 0 END) AS cooldown_polls,
           SUM(CASE WHEN status = 'fleet_out_of_region' THEN 1 ELSE 0 END) AS out_of_region_polls,
           AVG(latency_ms) AS avg_latency_ms,
           AVG(sample_count) AS avg_stations_per_poll,
           AVG(CASE WHEN sample_count > 0 THEN sample_count END) AS avg_stations_when_sampled,
           SUM(COALESCE(google_requests, 0)) AS google_requests,
           MIN(scheduled_at) AS first_scheduled_at,
           MAX(CASE WHEN status IN ('success', 'partial_success') THEN completed_at END) AS last_success_at,
           MAX(CASE WHEN source_used = 'fleet' THEN completed_at END) AS last_fleet_success_at,
           MAX(CASE WHEN source_used = 'google' THEN completed_at END) AS last_google_success_at
         FROM poll_runs
         WHERE scheduled_at >= ?`,
      )
      .bind(sinceIso)
      .first<{
        invocations: number;
        successful_polls: number;
        fleet_polls: number;
        google_polls: number;
        failed_polls: number;
        offline_polls: number;
        cooldown_polls: number;
        out_of_region_polls: number;
        avg_latency_ms: number | null;
        avg_stations_per_poll: number | null;
        avg_stations_when_sampled: number | null;
        google_requests: number | null;
        first_scheduled_at: string | null;
        last_success_at: string | null;
        last_fleet_success_at: string | null;
        last_google_success_at: string | null;
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
         WHERE scheduled_at >= ?
           AND fleet_status IS NOT NULL
           AND fleet_status >= 400
           AND status NOT IN ('fleet_vehicle_offline')
         GROUP BY fleet_status`,
      )
      .bind(sinceIso)
      .all<{ http_status: number; n: number }>(),
    db
      .prepare(
        `SELECT google_status AS http_status, COUNT(*) AS n
         FROM poll_runs
         WHERE scheduled_at >= ? AND google_status IS NOT NULL AND google_status >= 400
         GROUP BY google_status`,
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
    ...(googleErrors.results ?? []).map((row) => ({
      source: "google" as const,
      httpStatus: Number(row.http_status),
      count: Number(row.n) || 0,
    })),
  ];

  return {
    invocations: Number(totals?.invocations) || 0,
    successfulPolls: Number(totals?.successful_polls) || 0,
    fleetPolls: Number(totals?.fleet_polls) || 0,
    googlePolls: Number(totals?.google_polls) || 0,
    failedPolls: Number(totals?.failed_polls) || 0,
    offlinePolls: Number(totals?.offline_polls) || 0,
    cooldownPolls: Number(totals?.cooldown_polls) || 0,
    outOfRegionPolls: Number(totals?.out_of_region_polls) || 0,
    avgLatencyMs: round1(totals?.avg_latency_ms),
    avgStationsPerPoll: round1(totals?.avg_stations_per_poll),
    avgStationsWhenSampled: round1(totals?.avg_stations_when_sampled),
    googleRequests: Number(totals?.google_requests) || 0,
    firstScheduledAt: totals?.first_scheduled_at ?? null,
    lastSuccessAt: totals?.last_success_at ?? null,
    lastFleetSuccessAt: totals?.last_fleet_success_at ?? null,
    lastGoogleSuccessAt: totals?.last_google_success_at ?? null,
    last: last ?? null,
    statusCounts,
    httpErrors,
    samples: Number(sampleCounts?.samples) || 0,
    staleSamples: Number(sampleCounts?.stale_samples) || 0,
  };
}
