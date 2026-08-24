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
         max_power_kw, amenities, match_method, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         fleet_id = COALESCE(excluded.fleet_id, stations.fleet_id),
         graphql_id = COALESCE(excluded.graphql_id, stations.graphql_id),
         name = excluded.name,
         total_stalls = COALESCE(excluded.total_stalls, stations.total_stalls),
         max_power_kw = COALESCE(excluded.max_power_kw, stations.max_power_kw),
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
           max_power_kw, amenities, match_method, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fleet_id = COALESCE(excluded.fleet_id, stations.fleet_id),
           graphql_id = COALESCE(excluded.graphql_id, stations.graphql_id),
           name = excluded.name,
           total_stalls = COALESCE(excluded.total_stalls, stations.total_stalls),
           max_power_kw = COALESCE(excluded.max_power_kw, stations.max_power_kw),
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
           poll_run_id, station_id, observed_at, source, available_stalls, total_stalls,
           occupied_stalls, utilization_pct, site_closed, congestion_sync_at,
           congestion_age_seconds, is_stale
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(poll_run_id, station_id) DO UPDATE SET
           observed_at = excluded.observed_at,
           source = excluded.source,
           available_stalls = excluded.available_stalls,
           total_stalls = excluded.total_stalls,
           occupied_stalls = excluded.occupied_stalls,
           utilization_pct = excluded.utilization_pct,
           site_closed = excluded.site_closed,
           congestion_sync_at = excluded.congestion_sync_at,
           congestion_age_seconds = excluded.congestion_age_seconds,
           is_stale = excluded.is_stale`,
      ).bind(
        pollRunId,
        station.id,
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

export async function coverageSince(
  db: D1Database,
  sinceIso: string,
): Promise<{ invocations: number; withSamples: number; last: PollRunRow | null }> {
  const rows = await db
    .prepare(
      `SELECT * FROM poll_runs WHERE scheduled_at >= ? ORDER BY scheduled_at DESC`,
    )
    .bind(sinceIso)
    .all<PollRunRow>();
  const results = rows.results ?? [];
  return {
    invocations: results.length,
    withSamples: results.filter((row) => (row.sample_count ?? 0) > 0).length,
    last: results[0] ?? null,
  };
}
