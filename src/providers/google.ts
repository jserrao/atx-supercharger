import { inferHardwareGeneration } from "../hardware";
import { occupancyFromStalls } from "../observations";
import type { AppConfig, ChargerObservation, ProviderResult } from "../types";

export const GOOGLE_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.evChargeOptions",
].join(",");

const MAX_PAGES = 3;

export type ConnectorAgg = {
  type?: string;
  count?: number;
  availableCount?: number;
  outOfServiceCount?: number;
  maxChargeRateKw?: number;
  availabilityLastUpdateTime?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function placeId(raw: unknown): string | null {
  const id = String(raw ?? "").trim();
  if (!id) return null;
  return id.replace(/^places\//, "");
}

export function isTeslaSupercharger(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("supercharger") || lower.includes("super charger");
}

function isTeslaConnector(type: string): boolean {
  const upper = type.toUpperCase();
  return upper.includes("TESLA") || upper.includes("NACS");
}

export function searchTextBody(config: AppConfig, pageToken?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    textQuery: "Tesla Supercharger",
    includedType: "electric_vehicle_charging_station",
    maxResultCount: 20,
    locationRestriction: {
      rectangle: {
        low: { latitude: config.bbox.south, longitude: config.bbox.west },
        high: { latitude: config.bbox.north, longitude: config.bbox.east },
      },
    },
  };
  if (pageToken) body.pageToken = pageToken;
  return body;
}

export function occupancyFromConnectors(aggregations: ConnectorAgg[]): {
  availableStalls: number | null;
  totalStalls: number | null;
  occupiedStalls: number | null;
  utilizationPct: number | null;
  outOfServiceStalls: number;
  maxPowerKw: number | null;
  congestionSyncAt: string | null;
  siteClosed: boolean | null;
} {
  const tesla = aggregations.filter((row) => isTeslaConnector(String(row.type ?? "")));
  const rows = tesla.length > 0 ? tesla : aggregations;
  if (rows.length === 0) {
    return {
      availableStalls: null,
      totalStalls: null,
      occupiedStalls: null,
      utilizationPct: null,
      outOfServiceStalls: 0,
      maxPowerKw: null,
      congestionSyncAt: null,
      siteClosed: null,
    };
  }

  let physical = 0;
  let oos = 0;
  let available: number | null = 0;
  let maxPower: number | null = null;
  let syncAt: string | null = null;
  let sawAvailable = false;

  for (const row of rows) {
    physical += Number(row.count) || 0;
    oos += Number(row.outOfServiceCount) || 0;
    if (row.availableCount != null && Number.isFinite(Number(row.availableCount))) {
      sawAvailable = true;
      available = (available ?? 0) + Number(row.availableCount);
    }
    const power = Number(row.maxChargeRateKw);
    if (Number.isFinite(power)) {
      maxPower = maxPower == null ? power : Math.max(maxPower, power);
    }
    if (row.availabilityLastUpdateTime) {
      if (!syncAt || row.availabilityLastUpdateTime > syncAt) syncAt = row.availabilityLastUpdateTime;
    }
  }

  const usable = physical - oos;
  const offline = usable <= 0;

  if (offline) {
    return {
      availableStalls: sawAvailable ? 0 : null,
      totalStalls: physical > 0 ? physical : 0,
      occupiedStalls: null,
      utilizationPct: null,
      outOfServiceStalls: oos,
      maxPowerKw: maxPower,
      congestionSyncAt: syncAt,
      siteClosed: true,
    };
  }

  if (!sawAvailable) {
    return {
      availableStalls: null,
      totalStalls: usable,
      occupiedStalls: null,
      utilizationPct: null,
      outOfServiceStalls: oos,
      maxPowerKw: maxPower,
      congestionSyncAt: syncAt,
      siteClosed: null,
    };
  }

  const occupancy = occupancyFromStalls(available, usable);
  return {
    availableStalls: available,
    totalStalls: usable,
    occupiedStalls: occupancy.occupiedStalls,
    utilizationPct: occupancy.utilizationPct,
    outOfServiceStalls: oos,
    maxPowerKw: maxPower,
    congestionSyncAt: syncAt,
    siteClosed: false,
  };
}

export function normalizeGooglePlaces(payload: unknown, observedAt: string): ChargerObservation[] {
  const places = Array.isArray(asRecord(payload).places) ? (asRecord(payload).places as unknown[]) : [];
  const observations: ChargerObservation[] = [];

  for (const item of places) {
    const place = asRecord(item);
    const name = String(asRecord(place.displayName).text ?? place.displayName ?? "");
    const id = placeId(place.id);
    const latitude = Number(asRecord(place.location).latitude);
    const longitude = Number(asRecord(place.location).longitude);
    if (!id || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (!isTeslaSupercharger(name)) continue;

    const options = asRecord(place.evChargeOptions);
    const aggregations = Array.isArray(options.connectorAggregation)
      ? (options.connectorAggregation as ConnectorAgg[])
      : [];
    const occ = occupancyFromConnectors(aggregations);

    observations.push({
      source: "google",
      sourceStationId: id,
      name,
      latitude,
      longitude,
      availableStalls: occ.availableStalls,
      totalStalls: occ.totalStalls,
      occupiedStalls: occ.occupiedStalls,
      utilizationPct: occ.utilizationPct,
      siteClosed: occ.siteClosed,
      maxPowerKw: occ.maxPowerKw,
      hardwareGeneration: inferHardwareGeneration(name, occ.maxPowerKw),
      billingInfo: null,
      congestionSyncAt: occ.congestionSyncAt,
      congestionAgeSeconds: occ.congestionSyncAt
        ? Math.max(0, Math.round((Date.parse(observedAt) - Date.parse(occ.congestionSyncAt)) / 1000))
        : null,
      observedAt,
      amenities: null,
      raw: item,
    });
  }
  return observations;
}

function errorResult(
  status: number,
  error: string,
  raw: unknown,
  requestCount: number,
): ProviderResult {
  return {
    ok: false,
    status,
    source: "google",
    observations: [],
    raw,
    error,
    requestCount,
  };
}

export async function fetchGoogleNearbySites(
  env: Env,
  config: AppConfig,
  observedAt: string,
): Promise<ProviderResult> {
  if (!config.googlePlacesApiKey) {
    return errorResult(503, "google_key_missing", { error: "google_key_missing" }, 0);
  }

  let pageToken: string | undefined;
  let requestCount = 0;
  let lastStatus = 0;
  const merged: { places: unknown[] } = { places: [] };
  let lastRaw: unknown = merged;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    requestCount += 1;
    const response = await fetch(GOOGLE_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(searchTextBody(config, pageToken)),
    });
    lastStatus = response.status;

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = { error: "non_json_response" };
    }
    lastRaw = data;

    if (response.status === 401 || response.status === 403) {
      return errorResult(response.status, "google_auth_failure", data, requestCount);
    }
    if (!response.ok) {
      return errorResult(response.status, `google_http_${response.status}`, data, requestCount);
    }

    const record = asRecord(data);
    const places = Array.isArray(record.places) ? record.places : [];
    merged.places.push(...places);
    const next = typeof record.nextPageToken === "string" ? record.nextPageToken : "";
    if (!next) break;
    pageToken = next;
  }

  const observations = normalizeGooglePlaces(merged, observedAt);
  return {
    ok: true,
    status: lastStatus || 200,
    source: "google",
    observations,
    raw: lastRaw,
    error: observations.length === 0 ? "no_data" : null,
    requestCount,
  };
}
