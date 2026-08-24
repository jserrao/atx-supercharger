import type { ChargerObservation, StationRecord } from "../types";
import { haversineMeters, namesReasonablyMatch } from "../geo";

export type StationMatch = {
  station: StationRecord;
  method: "source_id" | "geo_name" | "created";
  created: boolean;
};

function sourceColumn(source: ChargerObservation["source"]): "fleet_id" | "graphql_id" {
  return source === "fleet" ? "fleet_id" : "graphql_id";
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
      name: observation.name,
      latitude: observation.latitude,
      longitude: observation.longitude,
      total_stalls: observation.totalStalls,
      max_power_kw: observation.maxPowerKw,
      amenities: observation.amenities == null ? null : JSON.stringify(observation.amenities),
      match_method: method,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
    };
  }

  return {
    ...existing,
    [column]: existing[column] ?? observation.sourceStationId,
    name: existing.name || observation.name,
    latitude: existing.latitude,
    longitude: existing.longitude,
    total_stalls: observation.totalStalls ?? existing.total_stalls,
    max_power_kw: observation.maxPowerKw ?? existing.max_power_kw,
    amenities:
      observation.amenities == null
        ? existing.amenities
        : JSON.stringify(observation.amenities),
    match_method: existing.match_method ?? method,
    last_seen_at: nowIso,
  };
}
