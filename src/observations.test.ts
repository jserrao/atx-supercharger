import { describe, expect, it } from "vitest";
import type { ChargerObservation } from "./types";
import {
  congestionAgeSeconds,
  filterToBbox,
  isStale,
  occupancyFromStalls,
  unixSecondsToIso,
} from "./observations";

function obs(lat: number, lon: number): ChargerObservation {
  return {
    source: "fleet",
    sourceStationId: "1",
    name: "Test",
    latitude: lat,
    longitude: lon,
    availableStalls: 4,
    totalStalls: 8,
    occupiedStalls: 4,
    utilizationPct: 50,
    siteClosed: false,
    maxPowerKw: 250,
    congestionSyncAt: null,
    congestionAgeSeconds: null,
    observedAt: "2026-08-24T00:00:00.000Z",
    amenities: null,
    raw: {},
  };
}

describe("observations", () => {
  it("computes occupancy and utilization", () => {
    expect(occupancyFromStalls(3, 10)).toEqual({ occupiedStalls: 7, utilizationPct: 70 });
  });

  it("does not divide by zero", () => {
    expect(occupancyFromStalls(0, 0)).toEqual({ occupiedStalls: null, utilizationPct: null });
  });

  it("flags congestion older than 15 minutes", () => {
    const observedAt = "2026-08-24T12:20:00.000Z";
    const congestionSyncAt = "2026-08-24T12:00:00.000Z";
    const age = congestionAgeSeconds(observedAt, congestionSyncAt);
    expect(age).toBe(1200);
    expect(isStale(age, 900)).toBe(true);
    expect(isStale(800, 900)).toBe(false);
  });

  it("converts tesla unix seconds to iso", () => {
    expect(unixSecondsToIso(1700000000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("drops out-of-bbox sites", () => {
    const bbox = { north: 30.5, south: 30.0, west: -98.25, east: -97.7 };
    const kept = filterToBbox([obs(30.3, -97.9), obs(29.7, -95.4)], bbox);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.latitude).toBe(30.3);
  });
});
