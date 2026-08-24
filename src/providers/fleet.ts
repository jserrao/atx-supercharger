import type { AppConfig, ChargerObservation, ProviderResult, VehicleSnapshot } from "../types";
import { teslaGet } from "../auth/tesla";
import { siteHardwareFromRaw } from "../hardware";
import { asFiniteNumber, occupancyFromStalls, unixSecondsToIso } from "../observations";

type FleetSite = {
  id?: unknown;
  id_s?: unknown;
  name?: unknown;
  location?: { lat?: unknown; long?: unknown; longitude?: unknown };
  available_stalls?: unknown;
  total_stalls?: unknown;
  site_closed?: unknown;
  amenities?: unknown;
  max_power_kw?: unknown;
  distance_miles?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function pickVehicle(
  vehicles: unknown,
  configuredVin: string,
): VehicleSnapshot | null {
  const list = Array.isArray(vehicles) ? vehicles : [];
  const records = list.map(asRecord);
  const match = configuredVin
    ? records.find((vehicle) => String(vehicle.vin ?? "") === configuredVin)
    : records[0];
  if (!match) return null;
  return {
    vin: match.vin ? String(match.vin) : configuredVin || null,
    displayName: match.display_name ? String(match.display_name) : null,
    state: match.state ? String(match.state) : null,
  };
}

function fleetSourceId(site: FleetSite): string | null {
  if (site.id != null && String(site.id).trim()) return String(site.id);
  if (site.id_s != null && String(site.id_s).trim()) return String(site.id_s);
  const lat = asFiniteNumber(site.location?.lat);
  const lon = asFiniteNumber(site.location?.long ?? site.location?.longitude);
  if (lat == null || lon == null) return null;
  return `geo:${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function normalizeFleetSites(
  payload: unknown,
  observedAt: string,
): ChargerObservation[] {
  const body = asRecord(asRecord(payload).response ?? payload);
  const superchargers = Array.isArray(body.superchargers) ? body.superchargers : [];
  const congestionSyncAt =
    unixSecondsToIso(body.congestion_sync_time_utc_secs) ??
    unixSecondsToIso(body.timestamp);

  const observations: ChargerObservation[] = [];
  for (const item of superchargers) {
    const site = asRecord(item) as FleetSite;
    const latitude = asFiniteNumber(site.location?.lat);
    const longitude = asFiniteNumber(site.location?.long ?? site.location?.longitude);
    const sourceStationId = fleetSourceId(site);
    const name = site.name ? String(site.name) : "";
    if (latitude == null || longitude == null || !sourceStationId || !name) continue;

    const availableStalls = asFiniteNumber(site.available_stalls);
    const totalStalls = asFiniteNumber(site.total_stalls);
    const { occupiedStalls, utilizationPct } = occupancyFromStalls(
      availableStalls,
      totalStalls,
    );
    const hardware = siteHardwareFromRaw(site, name);

    observations.push({
      source: "fleet",
      sourceStationId,
      name,
      latitude,
      longitude,
      availableStalls,
      totalStalls,
      occupiedStalls,
      utilizationPct,
      siteClosed: typeof site.site_closed === "boolean" ? site.site_closed : null,
      maxPowerKw: hardware.maxPowerKw,
      hardwareGeneration: hardware.hardwareGeneration,
      billingInfo: hardware.billingInfo,
      congestionSyncAt,
      congestionAgeSeconds: congestionSyncAt
        ? Math.max(0, Math.round((Date.parse(observedAt) - Date.parse(congestionSyncAt)) / 1000))
        : null,
      observedAt,
      amenities: hardware.amenities,
      raw: item,
    });
  }
  return observations;
}

export async function fetchVehicleList(
  env: Env,
  config: AppConfig,
): Promise<{ result: Awaited<ReturnType<typeof teslaGet>>; vehicle: VehicleSnapshot | null }> {
  const result = await teslaGet(env, config, "/api/1/vehicles");
  const response = asRecord(result.data).response;
  const vehicle = pickVehicle(response, config.teslaVin);
  return { result, vehicle };
}

export async function fetchNearbyChargingSites(
  env: Env,
  config: AppConfig,
  vin: string,
  observedAt: string,
): Promise<ProviderResult> {
  const path = `/api/1/vehicles/${encodeURIComponent(vin)}/nearby_charging_sites?count=${config.fleetCount}&radius=${config.fleetRadius}&detail=true`;
  const result = await teslaGet(env, config, path);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      source: "fleet",
      observations: [],
      raw: result.data,
      error: errorMessage(result.data) ?? `fleet_http_${result.status}`,
    };
  }
  return {
    ok: true,
    status: result.status,
    source: "fleet",
    observations: normalizeFleetSites(result.data, observedAt),
    raw: result.data,
    error: null,
  };
}

function errorMessage(data: unknown): string | null {
  const record = asRecord(data);
  if (typeof record.error === "string") return record.error;
  if (typeof record.response === "string") return record.response;
  return null;
}
