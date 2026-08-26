import type { ChargerObservation, StationRecord } from "../types";
import { haversineMeters, namesReasonablyMatch, normalizeStationName } from "../geo";

export type StationMatch = {
  station: StationRecord;
  method: "source_id" | "geo_name" | "created";
  created: boolean;
};

function sourceColumn(
  source: ChargerObservation["source"],
): "fleet_id" | "graphql_id" | "google_place_id" {
  if (source === "fleet") return "fleet_id";
  if (source === "google") return "google_place_id";
  return "graphql_id";
}

export function matchStation(
  stations: StationRecord[],
  observation: ChargerObservation,
  matchDistanceMeters: number,
): { existing: StationRecord; method: "source_id" | "geo_name" } | null {
  const column = sourceColumn(observation.source);
  const byId = stations.find((station) => station[column] === observation.sourceStationId);
  if (byId) return { existing: byId, method: "source_id" };

  const nearby = stations.filter((station) => {
    const distance = haversineMeters(
      station.latitude,
      station.longitude,
      observation.latitude,
      observation.longitude,
    );
    return distance <= matchDistanceMeters;
  });

  const named = nearby.find((station) => namesReasonablyMatch(station.name, observation.name));
  if (named) return { existing: named, method: "geo_name" };

  const generic = !normalizeStationName(observation.name);
  if (generic && nearby.length === 1 && nearby[0]) {
    return { existing: nearby[0], method: "geo_name" };
  }
  return null;
}

export function applyObservationToStation(
  existing: StationRecord | null,
  observation: ChargerObservation,
  nowIso: string,
  method: StationMatch["method"],
): StationRecord {
  const column = sourceColumn(observation.source);
  if (!existing) {
    return {
      id: crypto.randomUUID(),
      fleet_id: observation.source === "fleet" ? observation.sourceStationId : null,
      graphql_id: observation.source === "graphql" ? observation.sourceStationId : null,
      google_place_id: observation.source === "google" ? observation.sourceStationId : null,
      name: observation.name,
      latitude: observation.latitude,
      longitude: observation.longitude,
      total_stalls: observation.totalStalls,
      max_power_kw: observation.maxPowerKw,
      hardware_generation: observation.hardwareGeneration,
      amenities:
        typeof observation.amenities === "string"
          ? observation.amenities
          : observation.amenities == null
            ? null
            : JSON.stringify(observation.amenities),
      match_method: method,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
    };
  }

  const nextName = normalizeStationName(observation.name)
    ? observation.name || existing.name
    : existing.name;

  return {
    ...existing,
    [column]: existing[column] ?? observation.sourceStationId,
    name: nextName,
    latitude: existing.latitude,
    longitude: existing.longitude,
    total_stalls: observation.totalStalls ?? existing.total_stalls,
    max_power_kw: observation.maxPowerKw ?? existing.max_power_kw,
    hardware_generation:
      observation.hardwareGeneration !== "unknown"
        ? observation.hardwareGeneration
        : existing.hardware_generation,
    amenities:
      observation.amenities == null
        ? existing.amenities
        : typeof observation.amenities === "string"
          ? observation.amenities
          : JSON.stringify(observation.amenities),
    match_method: existing.match_method ?? method,
    last_seen_at: nowIso,
  };
}
