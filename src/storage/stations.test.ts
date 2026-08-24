import { describe, expect, it } from "vitest";
import type { ChargerObservation, StationRecord } from "../types";
import { applyObservationToStation, matchStation } from "./stations";

function station(overrides: Partial<StationRecord>): StationRecord {
  return {
    id: "station-1",
    fleet_id: "111",
    graphql_id: null,
    name: "Bee Cave",
    latitude: 30.306,
    longitude: -97.952,
    total_stalls: 8,
    max_power_kw: 250,
    hardware_generation: "v3_or_v4",
    amenities: null,
    match_method: "source_id",
    first_seen_at: "2026-08-24T00:00:00.000Z",
    last_seen_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function observation(overrides: Partial<ChargerObservation>): ChargerObservation {
  return {
    source: "graphql",
    sourceStationId: "g-1",
    name: "Austin - Bee Cave",
    latitude: 30.3061,
    longitude: -97.9521,
    availableStalls: 3,
    totalStalls: 8,
    occupiedStalls: 5,
    utilizationPct: 62.5,
    siteClosed: false,
    maxPowerKw: 250,
    hardwareGeneration: "v3_or_v4",
    billingInfo: null,
    congestionSyncAt: null,
    congestionAgeSeconds: null,
    observedAt: "2026-08-24T00:00:00.000Z",
    amenities: null,
    raw: {},
    ...overrides,
  };
}

describe("station matching", () => {
  it("matches an existing source-specific id first", () => {
    const match = matchStation(
      [station({ graphql_id: "g-1", name: "Other" })],
      observation(),
      150,
    );
    expect(match?.method).toBe("source_id");
    expect(match?.existing.id).toBe("station-1");
  });

  it("merges nearby sites with similar names", () => {
    const match = matchStation([station()], observation(), 150);
    expect(match?.method).toBe("geo_name");
  });

  it("does not merge stacked V3/V4 sites", () => {
    const match = matchStation(
      [station({ name: "Austin Supercharger V3", total_stalls: 8 })],
      observation({
        name: "Austin Supercharger V4",
        totalStalls: 20,
        latitude: 30.30605,
        longitude: -97.95205,
      }),
      150,
    );
    expect(match).toBeNull();
  });

  it("keeps Tesla source IDs and the display name on the canonical station", () => {
    const created = applyObservationToStation(
      null,
      observation({ source: "fleet", sourceStationId: "4242", name: "Bee Cave" }),
      "2026-08-24T00:00:00.000Z",
      "created",
    );
    expect(created.fleet_id).toBe("4242");
    expect(created.name).toBe("Bee Cave");
    expect(created.hardware_generation).toBe("v3_or_v4");

    const renamed = applyObservationToStation(
      created,
      observation({ source: "fleet", sourceStationId: "4242", name: "Austin - Bee Cave" }),
      "2026-08-24T00:05:00.000Z",
      "source_id",
    );
    expect(renamed.fleet_id).toBe("4242");
    expect(renamed.name).toBe("Austin - Bee Cave");
  });

  it("does not match on name alone", () => {
    const match = matchStation(
      [station({ latitude: 29.4, longitude: -98.5, name: "Bee Cave" })],
      observation({ name: "Bee Cave" }),
      150,
    );
    expect(match).toBeNull();
  });
});
