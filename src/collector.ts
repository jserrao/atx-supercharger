import { googleEnabled, loadConfig } from "./config";
import { cadenceBucket, lockTtlSeconds } from "./cadence";
import { logError, logInfo } from "./log";
import { filterToBbox } from "./observations";
import { fetchNearbyChargingSites, fetchVehicleList } from "./providers/fleet";
import { fetchGoogleNearbySites } from "./providers/google";
import {
  claimPollRun,
  completePollRun,
  insertComparisons,
  insertRawResponse,
  lastGoogleAttemptAt,
  persistObservations,
  pruneRawResponses,
} from "./storage/d1";
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
  forceSource?: "fleet" | "google" | "auto";
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
  const second = await run();
  return {
    ...second,
    requestCount: (first.requestCount ?? 0) + (second.requestCount ?? 0),
  };
}

function effectiveMode(config: AppConfig, forceSource?: CollectOptions["forceSource"]): CollectorMode {
  if (forceSource === "fleet") return "fleet_only";
  if (forceSource === "google") return "auto";
  if (forceSource === "auto") return "auto";
  return config.collectorMode;
}

function googleDue(lastAttemptIso: string | null, fallbackMinutes: number, now: Date): boolean {
  if (!lastAttemptIso) return true;
  const last = Date.parse(lastAttemptIso);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= fallbackMinutes * 60_000;
}

function buildComparisons(
  fleet: ChargerObservation[],
  google: ChargerObservation[],
  matchDistanceMeters: number,
): SourceComparison[] {
  return fleet.map((fleetObs) => {
    const match = google.find((googleObs) => {
      const distance = haversineMeters(
        fleetObs.latitude,
        fleetObs.longitude,
        googleObs.latitude,
        googleObs.longitude,
      );
      return distance <= matchDistanceMeters && namesReasonablyMatch(fleetObs.name, googleObs.name);
    });
    const fleetAvailable = fleetObs.availableStalls;
    const googleAvailable = match?.availableStalls ?? null;
    return {
      stationId: null,
      fleetAvailable,
      googleAvailable,
      availableDelta:
        fleetAvailable != null && googleAvailable != null ? googleAvailable - fleetAvailable : null,
      congestionAgeDeltaSeconds:
        fleetObs.congestionAgeSeconds != null && match?.congestionAgeSeconds != null
          ? match.congestionAgeSeconds - fleetObs.congestionAgeSeconds
          : null,
      identityMatch: Boolean(match),
    };
  });
}

type GoogleHandle = {
  status: PollStatus;
  error: string | null;
  sampleCount: number;
  persisted: ChargerObservation[];
  sourceUsed: string | null;
  googleStatus: number | null;
  googleRequests: number;
};

async function handleGoogleResult(
  env: Env,
  config: AppConfig,
  pollRunId: string,
  scheduledAt: string,
  google: ProviderResult,
  fallbackReason: PollStatus,
): Promise<Omit<GoogleHandle, "googleStatus" | "googleRequests">> {
  if (google.error === "google_auth_failure" || google.status === 401 || google.status === 403) {
    return {
      status: "google_auth_failure",
      error: google.error,
      sampleCount: 0,
      persisted: [],
      sourceUsed: null,
    };
  }
  if (google.status === 429) {
    return {
      status: "google_rate_limited",
      error: "google_rate_limited",
      sampleCount: 0,
      persisted: [],
      sourceUsed: null,
    };
  }
  if (!google.ok) {
    return {
      status: "google_error",
      error: google.error ?? fallbackReason,
      sampleCount: 0,
      persisted: [],
      sourceUsed: null,
    };
  }

  const inBbox = filterToBbox(google.observations, config.bbox);
  if (inBbox.length === 0) {
    return {
      status: fallbackReason === "fleet_out_of_region" ? "no_data" : fallbackReason,
      error: "google_no_in_bbox_superchargers",
      sampleCount: 0,
      persisted: [],
      sourceUsed: "google",
    };
  }

  const saved = await persistObservations(env.DB, config, pollRunId, scheduledAt, inBbox);
  if (saved.sampleCount === 0) {
    return {
      status: fallbackReason === "fleet_out_of_region" ? "no_data" : fallbackReason,
      error: "google_no_matched_stations",
      sampleCount: 0,
      persisted: [],
      sourceUsed: "google",
    };
  }
  return {
    status: "success",
    error: null,
    sampleCount: saved.sampleCount,
    persisted: inBbox,
    sourceUsed: "google",
  };
}

async function collectFromGoogle(
  env: Env,
  config: AppConfig,
  pollRunId: string,
  scheduledAt: string,
  startedAt: string,
  vin: string,
  fallbackReason: PollStatus,
  options: { bypassCooldown: boolean; now: Date; persist: boolean },
): Promise<GoogleHandle> {
  if (!options.bypassCooldown) {
    const lastAttempt = await lastGoogleAttemptAt(env.DB);
    if (!googleDue(lastAttempt, config.googleFallbackMinutes, options.now)) {
      return {
        status: "google_cooldown",
        error: null,
        sampleCount: 0,
        persisted: [],
        sourceUsed: null,
        googleStatus: null,
        googleRequests: 0,
      };
    }
  }

  const google = await retry5xx(() => fetchGoogleNearbySites(env, config, startedAt));
  const googleRequests = google.requestCount ?? 1;
  await insertRawResponse(env.DB, pollRunId, "google", startedAt, sanitizeRaw(google.raw, vin));
  if (!options.persist) {
    const inBbox = google.ok ? filterToBbox(google.observations, config.bbox) : [];
    return {
      status: google.ok ? "success" : "google_error",
      error: google.error,
      sampleCount: 0,
      persisted: inBbox,
      sourceUsed: null,
      googleStatus: google.status,
      googleRequests,
    };
  }
  const handled = await handleGoogleResult(env, config, pollRunId, scheduledAt, google, fallbackReason);
  return {
    ...handled,
    googleStatus: google.status,
    googleRequests,
  };
}

export async function runCollection(env: Env, options: CollectOptions = {}): Promise<Record<string, unknown>> {
  const config = loadConfig(env);
  const now = options.now ?? new Date();
  const scheduledAt = cadenceBucket(now, config.collectionIntervalMinutes);
  const startedAt = now.toISOString();
  const vin = config.teslaVin;
  const mode = effectiveMode(config, options.forceSource);
  const startedMs = Date.now();

  const claimed = await claimPollRun(
    env.DB,
    {
      id: crypto.randomUUID(),
      scheduled_at: scheduledAt,
      started_at: startedAt,
      status: "success",
    },
    {
      force: Boolean(options.force),
      lockTtlSeconds: lockTtlSeconds(config.collectionIntervalMinutes),
      now,
    },
  );
  if (claimed.skipped && !options.force) {
    return {
      status: "lock_skipped",
      poll_run_id: claimed.id,
      scheduled_at: scheduledAt,
      reason: claimed.skipped,
    };
  }
  const pollRunId = claimed.id;

  let vehicleState: string | null = null;
  let sourceUsed: string | null = null;
  let fleetStatus: number | null = null;
  let googleStatus: number | null = null;
  let googleRequests = 0;
  let status: PollStatus = "no_data";
  let error: string | null = null;
  let sampleCount = 0;
  let persisted: ChargerObservation[] = [];

  const finishGoogle = (result: GoogleHandle) => {
    status = result.status;
    error = result.error;
    sampleCount = result.sampleCount;
    persisted = result.persisted;
    sourceUsed = result.sourceUsed;
    googleStatus = result.googleStatus;
    googleRequests += result.googleRequests;
  };

  try {
    if (options.forceSource === "google") {
      finishGoogle(
        await collectFromGoogle(
          env,
          config,
          pollRunId,
          scheduledAt,
          startedAt,
          vin,
          "google_error",
          { bypassCooldown: true, now, persist: true },
        ),
      );
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
      } else if (!vehicle) {
        status = "fleet_error";
        error = "vehicle_not_found";
      } else if (options.forceSource !== "fleet" && vehicleState && vehicleState !== "online") {
        if (googleEnabled(mode)) {
          finishGoogle(
            await collectFromGoogle(
              env,
              config,
              pollRunId,
              scheduledAt,
              startedAt,
              vin,
              "fleet_vehicle_offline",
              { bypassCooldown: false, now, persist: true },
            ),
          );
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
            }
          }

          const needGoogle =
            sampleCount === 0 &&
            (fleet.status === 408 || (fleet.ok && filterToBbox(fleet.observations, config.bbox).length === 0));

          if (fleet.status === 429 && sampleCount === 0) {
            status = "rate_limited";
            error = "fleet_rate_limited";
          } else if (needGoogle && sampleCount === 0) {
            const reason: PollStatus = fleet.status === 408 ? "fleet_vehicle_offline" : "fleet_out_of_region";
            if (googleEnabled(mode)) {
              finishGoogle(
                await collectFromGoogle(
                  env,
                  config,
                  pollRunId,
                  scheduledAt,
                  startedAt,
                  vin,
                  reason,
                  { bypassCooldown: false, now, persist: true },
                ),
              );
            } else if (fleet.ok) {
              status = "fleet_out_of_region";
              error = "no_in_bbox_superchargers";
            } else {
              status = "fleet_vehicle_offline";
              error = fleet.error;
            }
          } else if (!fleet.ok && sampleCount === 0 && fleet.status !== 429) {
            status = "fleet_error";
            error = fleet.error;
          }

          if (mode === "dual" && sourceUsed === "fleet" && googleEnabled(mode)) {
            const compare = await collectFromGoogle(
              env,
              config,
              pollRunId,
              scheduledAt,
              startedAt,
              vin,
              "google_error",
              { bypassCooldown: false, now, persist: false },
            );
            googleStatus = compare.googleStatus;
            googleRequests += compare.googleRequests;
            if (compare.status === "success" || compare.persisted.length > 0) {
              await insertComparisons(
                env.DB,
                pollRunId,
                startedAt,
                buildComparisons(persisted, compare.persisted, config.matchDistanceMeters),
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
      graphqlStatus: null,
      googleStatus,
      googleRequests,
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
      google_status: googleStatus,
      google_requests: googleRequests,
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
      google_status: googleStatus,
      google_requests: googleRequests,
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
      graphqlStatus: null,
      googleStatus,
      googleRequests,
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
  }
}
