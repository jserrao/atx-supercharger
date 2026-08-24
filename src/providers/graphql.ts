import type { AppConfig, ChargerObservation, ProviderResult } from "../types";
import { teslaPost } from "../auth/tesla";
import { asFiniteNumber, occupancyFromStalls } from "../observations";

export const GRAPHQL_URL =
  "https://akamai-apigateway-charging-ownership.tesla.com/graphql?operationName=GetNearbyChargingSites";

export const GET_NEARBY_CHARGING_SITES_QUERY = `query GetNearbyChargingSites($args: GetNearbyChargingSitesRequestType!) {
  charging {
    nearbySites(args: $args) {
      sitesAndDistances {
        haversineDistanceMiles
        drivingDistanceMiles
        location {
          ... on Supercharger {
            id
            localizedSiteName
            availableStalls
            totalStalls
            maxPowerKw
            siteType
            accessType
            centroid { latitude longitude }
            entryPoint { latitude longitude }
            activeOutages { message }
          }
          ... on ChargingSite {
            id
            localizedSiteName
            availableStalls
            totalStalls
            maxPowerKw
            siteType
            accessType
            centroid { latitude longitude }
            entryPoint { latitude longitude }
            activeOutages { message }
          }
        }
      }
    }
  }
}`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function bboxCenter(config: AppConfig): { latitude: number; longitude: number } {
  return {
    latitude: (config.bbox.north + config.bbox.south) / 2,
    longitude: (config.bbox.west + config.bbox.east) / 2,
  };
}

export function graphqlRequestBody(config: AppConfig): Record<string, unknown> {
  const userLocation = bboxCenter(config);
  return {
    operationName: "GetNearbyChargingSites",
    query: GET_NEARBY_CHARGING_SITES_QUERY,
    variables: {
      args: {
        userLocation,
        northwestCorner: {
          latitude: config.bbox.north,
          longitude: config.bbox.west,
        },
        southeastCorner: {
          latitude: config.bbox.south,
          longitude: config.bbox.east,
        },
        countryCode: "US",
        languageCode: "en-US",
      },
    },
  };
}

function walkSites(payload: unknown): unknown[] {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const charging = asRecord(data.charging);
  const nearbySites = asRecord(charging.nearbySites ?? data.nearbySites);
  const list = nearbySites.sitesAndDistances ?? nearbySites.sites;
  return Array.isArray(list) ? list : [];
}

function locationRecord(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.location && typeof entry.location === "object") {
    return asRecord(entry.location);
  }
  return entry;
}

function isSupercharger(site: Record<string, unknown>): boolean {
  const siteType = String(site.siteType ?? site.site_type ?? "").toLowerCase();
  if (!siteType) return true;
  return siteType.includes("supercharger") || siteType === "sc";
}

export function normalizeGraphqlSites(
  payload: unknown,
  observedAt: string,
): ChargerObservation[] {
  const observations: ChargerObservation[] = [];
  for (const item of walkSites(payload)) {
    const entry = asRecord(item);
    const site = locationRecord(entry);
    if (!isSupercharger(site)) continue;

    const centroid = asRecord(site.centroid);
    const entryPoint = asRecord(site.entryPoint);
    const latitude = asFiniteNumber(centroid.latitude ?? entryPoint.latitude ?? site.latitude);
    const longitude = asFiniteNumber(
      centroid.longitude ?? entryPoint.longitude ?? site.longitude,
    );
    const sourceStationId = site.id != null ? String(site.id) : null;
    const name = String(site.localizedSiteName ?? site.name ?? "");
    if (latitude == null || longitude == null || !sourceStationId || !name) continue;

    const availableStalls = asFiniteNumber(site.availableStalls ?? site.available_stalls);
    const totalStalls = asFiniteNumber(site.totalStalls ?? site.total_stalls);
    const { occupiedStalls, utilizationPct } = occupancyFromStalls(
      availableStalls,
      totalStalls,
    );

    observations.push({
      source: "graphql",
      sourceStationId,
      name,
      latitude,
      longitude,
      availableStalls,
      totalStalls,
      occupiedStalls,
      utilizationPct,
      siteClosed: Array.isArray(site.activeOutages) && site.activeOutages.length > 0,
      maxPowerKw: asFiniteNumber(site.maxPowerKw ?? site.max_power_kw),
      congestionSyncAt: null,
      congestionAgeSeconds: null,
      observedAt,
      amenities: null,
      raw: item,
    });
  }
  return observations;
}

export async function fetchGraphqlNearbySites(
  env: Env,
  config: AppConfig,
  observedAt: string,
): Promise<ProviderResult> {
  const result = await teslaPost(env, config, GRAPHQL_URL, graphqlRequestBody(config));
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      status: result.status,
      source: "graphql",
      observations: [],
      raw: result.data,
      error: "graphql_auth_failure",
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      source: "graphql",
      observations: [],
      raw: result.data,
      error: `graphql_http_${result.status}`,
    };
  }
  const observations = normalizeGraphqlSites(result.data, observedAt);
  return {
    ok: true,
    status: result.status,
    source: "graphql",
    observations,
    raw: result.data,
    error: observations.length === 0 ? "no_data" : null,
  };
}
