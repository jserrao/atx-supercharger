import { graphqlEnabled, loadConfig } from "./config";
import { cadenceBucket, lockTtlSeconds, shouldRunDual } from "./cadence";
import { logError, logInfo } from "./log";
import { filterToBbox } from "./observations";
import { fetchNearbyChargingSites, fetchVehicleList } from "./providers/fleet";
import { fetchGraphqlNearbySites } from "./providers/graphql";
import {
  completePollRun,
  getPollRunByScheduledAt,
  insertComparisons,
  insertPollRun,
  insertRawResponse,
  persistObservations,
  pruneRawResponses,
} from "./storage/d1";
import { acquireLock, recordSuccess, releaseLock } from "./storage/kv";
import { haversineMeters, namesReasonablyMatch } from "./geo";
import { sanitizeRaw } from "./redact";
import type {
  AppConfig,
  ChargerObservation,
  CollectorMode,
  PollStatus,
  ProviderResult,
  SourceComparison,
} from "./types";

export type CollectOptions = {
  now?: Date;
  force?: boolean;
  forceSource?: "fleet" | "graphql" | "auto";
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterDelay(): number {
  return 250 + Math.random() * 500;
}

function asError(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.response === "string") return record.response;
  return null;
}

async function retry5xx(run: () => Promise<ProviderResult>): Promise<ProviderResult> {
  const first = await run();
  if (first.status < 500) return first;
  await sleep(jitterDelay());
  return run();
}

function effectiveMode(config: AppConfig, forceSource?: CollectOptions["forceSource"]): CollectorMode {
  if (forceSource === "fleet") return "fleet_only";
  if (forceSource === "graphql") return "auto";
  if (forceSource === "auto") return "auto";
  return config.collectorMode;
}

function buildComparisons(
  fleet: ChargerObservation[],
  graphql: ChargerObservation[],
  matchDistanceMeters: number,
): SourceComparison[] {
  return fleet.map((fleetObs) => {
    const match = graphql.find((graphqlObs) => {
      const distance = haversineMeters(
        fleetObs.latitude,
        fleetObs.longitude,
        graphqlObs.latitude,
        graphqlObs.longitude,
      );
      return distance <= matchDistanceMeters && namesReasonablyMatch(fleetObs.name, graphqlObs.name);
    });
    const fleetAvailable = fleetObs.availableStalls;
    const graphqlAvailable = match?.availableStalls ?? null;
    return {
      stationId: null,
      fleetAvailable,
      graphqlAvailable,
      availableDelta:
        fleetAvailable != null && graphqlAvailable != null
          ? graphqlAvailable - fleetAvailable
          : null,
      congestionAgeDeltaSeconds:
        fleetObs.congestionAgeSeconds != null && match?.congestionAgeSeconds != null
          ? match.congestionAgeSeconds - fleetObs.congestionAgeSeconds
          : null,
      identityMatch: Boolean(match),
    };
  });
}

export async function runCollection(env: Env, options: CollectOptions = {}): Promise<Record<string, unknown>> {
  const config = loadConfig(env);
  const now = options.now ?? new Date();
  const scheduledAt = cadenceBucket(now, config.collectionIntervalMinutes);
  const startedAt = now.toISOString();
  const vin = config.teslaVin;
  const mode = effectiveMode(config, options.forceSource);
  const startedMs = Date.now();

  const existing = await getPollRunByScheduledAt(env.DB, scheduledAt);
  if (existing?.completed_at && !options.force) {
    return {
      status: "lock_skipped",
      poll_run_id: existing.id,
      scheduled_at: scheduledAt,
      reason: "bucket_already_completed",
    };
  }

  const locked = await acquireLock(env.KV, scheduledAt, lockTtlSeconds(config.collectionIntervalMinutes));
  if (!locked && !options.force) {
    return { status: "lock_skipped", scheduled_at: scheduledAt, reason: "lock_held" };
  }

  const createdId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await insertPollRun(env.DB, {
      id: createdId,
      scheduled_at: scheduledAt,
      started_at: startedAt,
      status: "success",
    });
  }
  const persistedRun = await getPollRunByScheduledAt(env.DB, scheduledAt);
  const pollRunId = persistedRun?.id ?? createdId;

  let vehicleState: string | null = null;
  let sourceUsed: string | null = null;
  let fleetStatus: number | null = null;
  let graphqlStatus: number | null = null;
  let status: PollStatus = "no_data";
  let error: string | null = null;
  let sampleCount = 0;
  let persisted: ChargerObservation[] = [];

  try {
    if (options.forceSource === "graphql") {
      const graphql = await retry5xx(() => fetchGraphqlNearbySites(env, config, startedAt));
      graphqlStatus = graphql.status;
      await insertRawResponse(
        env.DB,
        pollRunId,
        "graphql",
        startedAt,
        sanitizeRaw(graphql.raw, vin),
      );
      ({ status, error, sampleCount, persisted, sourceUsed } = await handleGraphqlOnly(
        env,
        config,
        pollRunId,
        scheduledAt,
        graphql,
      ));
    } else {
      const { result: vehiclesResult, vehicle } = await fetchVehicleList(env, config);
      vehicleState = vehicle?.state ?? null;

      if (vehiclesResult.status === 401) {
        status = "not_connected";
        error = asError(vehiclesResult.data) ?? "not_connected";
      } else if (vehiclesResult.status === 429) {
        status = "rate_limited";
        error = "fleet_vehicles_rate_limited";
      } else if (!vehiclesResult.ok) {
        status = "fleet_error";
        error = asError(vehiclesResult.data) ?? `vehicles_http_${vehiclesResult.status}`;
        if (graphqlEnabled(mode)) {
          const fallback = await retry5xx(() => fetchGraphqlNearbySites(env, config, startedAt));
          graphqlStatus = fallback.status;
          await insertRawResponse(
            env.DB,
            pollRunId,
            "graphql",
            startedAt,
            sanitizeRaw(fallback.raw, vin),
          );
          ({ status, error, sampleCount, persisted, sourceUsed } = await handleGraphqlFallback(
            env,
            config,
            pollRunId,
            scheduledAt,
            fallback,
            "fleet_error",
          ));
        }
      } else if (!vehicle) {
        status = "fleet_error";
        error = "vehicle_not_found";
      } else if (options.forceSource !== "fleet" && vehicleState && vehicleState !== "online") {
        if (graphqlEnabled(mode)) {
          const graphql = await retry5xx(() => fetchGraphqlNearbySites(env, config, startedAt));
          graphqlStatus = graphql.status;
          await insertRawResponse(
            env.DB,
            pollRunId,
            "graphql",
            startedAt,
            sanitizeRaw(graphql.raw, vin),
          );
          ({ status, error, sampleCount, persisted, sourceUsed } = await handleGraphqlFallback(
            env,
            config,
            pollRunId,
            scheduledAt,
            graphql,
            "fleet_vehicle_offline",
          ));
        } else {
          status = "fleet_vehicle_offline";
          error = `vehicle_${vehicleState}`;
        }
      } else {
        const vinForCall = vehicle?.vin ?? config.teslaVin;
        if (!vinForCall) {
          status = "fleet_error";
          error = "vin_not_configured";
        } else {
          const fleet = await retry5xx(() =>
            fetchNearbyChargingSites(env, config, vinForCall, startedAt),
          );
          fleetStatus = fleet.status;
          await insertRawResponse(env.DB, pollRunId, "fleet", startedAt, sanitizeRaw(fleet.raw, vin));

          const needGraphql =
            !fleet.ok ||
            fleet.status === 408 ||
            fleet.status === 429 ||
            fleet.status >= 500 ||
            filterToBbox(fleet.observations, config.bbox).length === 0;

          if (fleet.ok) {
            const inBbox = filterToBbox(fleet.observations, config.bbox);
            if (inBbox.length > 0) {
              const saved = await persistObservations(
                env.DB,
                config,
                pollRunId,
                scheduledAt,
                inBbox,
              );
              sampleCount = saved.sampleCount;
              persisted = inBbox;
              sourceUsed = "fleet";
              status = "success";
              await recordSuccess(env.KV, "fleet", startedAt);
            }
          }

          if (fleet.status === 429 && sampleCount === 0) {
            status = "rate_limited";
            error = "fleet_rate_limited";
          } else if (needGraphql && sampleCount === 0) {
            if (graphqlEnabled(mode)) {
              const graphql = await retry5xx(() => fetchGraphqlNearbySites(env, config, startedAt));
              graphqlStatus = graphql.status;
              await insertRawResponse(
                env.DB,
                pollRunId,
                "graphql",
                startedAt,
                sanitizeRaw(graphql.raw, vin),
              );
              const reason: PollStatus = !fleet.ok
                ? fleet.status === 408
                  ? "fleet_vehicle_offline"
                  : "fleet_error"
                : "fleet_out_of_region";
              ({ status, error, sampleCount, persisted, sourceUsed } = await handleGraphqlFallback(
                env,
                config,
                pollRunId,
                scheduledAt,
                graphql,
                reason,
              ));
            } else if (fleet.ok) {
              status = "fleet_out_of_region";
              error = "no_in_bbox_superchargers";
            } else if (fleet.status === 408) {
              status = "fleet_vehicle_offline";
              error = fleet.error;
            } else {
              status = "fleet_error";
              error = fleet.error;
            }
          }

          if (
            mode === "dual" &&
            sourceUsed === "fleet" &&
            shouldRunDual(now) &&
            graphqlEnabled(mode)
          ) {
            const graphql = await retry5xx(() => fetchGraphqlNearbySites(env, config, startedAt));
            graphqlStatus = graphql.status;
            await insertRawResponse(
              env.DB,
              pollRunId,
              "graphql",
              startedAt,
              sanitizeRaw(graphql.raw, vin),
            );
            if (graphql.ok) {
              const graphqlInBbox = filterToBbox(graphql.observations, config.bbox);
              await insertComparisons(
                env.DB,
                pollRunId,
                startedAt,
                buildComparisons(persisted, graphqlInBbox, config.matchDistanceMeters),
              );
            }
          }
        }
      }
    }

    await pruneRawResponses(env.DB, config.rawRetentionDays, now);
    await completePollRun(env.DB, pollRunId, {
      completedAt: new Date().toISOString(),
      vehicleState,
      sourceUsed,
      fleetStatus,
      graphqlStatus,
      sampleCount,
      latencyMs: Date.now() - startedMs,
      status,
      error,
    });

    logInfo(vin, {
      message: "collection complete",
      poll_run_id: pollRunId,
      scheduled_at: scheduledAt,
      status,
      source_used: sourceUsed,
      sample_count: sampleCount,
      vehicle_state: vehicleState,
      fleet_status: fleetStatus,
      graphql_status: graphqlStatus,
      latency_ms: Date.now() - startedMs,
    });

    return {
      poll_run_id: pollRunId,
      scheduled_at: scheduledAt,
      status,
      source_used: sourceUsed,
      sample_count: sampleCount,
      vehicle_state: vehicleState,
      fleet_status: fleetStatus,
      graphql_status: graphqlStatus,
      error,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    logError(vin, { message: "collection failed", error: message, poll_run_id: pollRunId });
    await completePollRun(env.DB, pollRunId, {
      completedAt: new Date().toISOString(),
      vehicleState,
      sourceUsed,
      fleetStatus,
      graphqlStatus,
      sampleCount,
      latencyMs: Date.now() - startedMs,
      status: "fleet_error",
      error: message,
    });
    return {
      poll_run_id: pollRunId,
      scheduled_at: scheduledAt,
      status: "fleet_error",
      error: message,
    };
  } finally {
    await releaseLock(env.KV, scheduledAt);
  }
}

async function handleGraphqlOnly(
  env: Env,
  config: AppConfig,
  pollRunId: string,
  scheduledAt: string,
  graphql: ProviderResult,
): Promise<{
  status: PollStatus;
  error: string | null;
  sampleCount: number;
  persisted: ChargerObservation[];
  sourceUsed: string | null;
}> {
  return handleGraphqlFallback(env, config, pollRunId, scheduledAt, graphql, "graphql_error");
}

async function handleGraphqlFallback(
  env: Env,
  config: AppConfig,
  pollRunId: string,
  scheduledAt: string,
  graphql: ProviderResult,
  fallbackReason: PollStatus,
): Promise<{
  status: PollStatus;
  error: string | null;
  sampleCount: number;
  persisted: ChargerObservation[];
  sourceUsed: string | null;
}> {
  if (graphql.error === "graphql_auth_failure" || graphql.status === 401 || graphql.status === 403) {
    return {
      status: "graphql_auth_failure",
      error: graphql.error,
      sampleCount: 0,
      persisted: [],
      sourceUsed: null,
    };
  }
  if (graphql.status === 429) {
    return {
      status: "rate_limited",
      error: "graphql_rate_limited",
      sampleCount: 0,
      persisted: [],
      sourceUsed: null,
    };
  }
  if (!graphql.ok) {
    return {
      status: graphqlEnabled(config.collectorMode) ? "graphql_error" : fallbackReason,
      error: graphql.error ?? fallbackReason,
      sampleCount: 0,
      persisted: [],
      sourceUsed: null,
    };
  }

  const inBbox = filterToBbox(graphql.observations, config.bbox);
  if (inBbox.length === 0) {
    return {
      status: fallbackReason === "fleet_out_of_region" ? "no_data" : fallbackReason,
      error: "graphql_no_in_bbox_superchargers",
      sampleCount: 0,
      persisted: [],
      sourceUsed: "graphql",
    };
  }

  const saved = await persistObservations(env.DB, config, pollRunId, scheduledAt, inBbox);
  await recordSuccess(env.KV, "graphql", inBbox[0]?.observedAt ?? new Date().toISOString());
  return {
    status: "success",
    error: null,
    sampleCount: saved.sampleCount,
    persisted: inBbox,
    sourceUsed: "graphql",
  };
}
