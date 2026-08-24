import { describe, expect, it } from "vitest";
import { normalizeFleetSites, pickVehicle } from "./fleet";

const payload = {
  response: {
    congestion_sync_time_utc_secs: 1700000000,
    timestamp: 1700000300,
    superchargers: [
      {
        id: 4242,
        name: "Bee Cave",
        location: { lat: 30.306, long: -97.952 },
        available_stalls: 2,
        total_stalls: 8,
        site_closed: false,
        amenities: "restrooms,restaurant",
      },
      {
        name: "Missing coords",
        available_stalls: 1,
        total_stalls: 4,
      },
    ],
    destination_charging: [
      {
        id: 99,
        name: "Hotel destination",
        location: { lat: 30.3, long: -97.8 },
        available_stalls: 1,
        total_stalls: 2,
      },
    ],
  },
};

describe("fleet provider", () => {
  it("picks the configured VIN and does not fall back to another car", () => {
    const vehicle = pickVehicle(
      [
        { vin: "5YJSA", display_name: "Model S", state: "online" },
        { vin: "5YJ3E1EA7MF000000", display_name: "Model 3", state: "asleep" },
      ],
      "5YJ3E1EA7MF000000",
    );
    expect(vehicle).toEqual({
      vin: "5YJ3E1EA7MF000000",
      displayName: "Model 3",
      state: "asleep",
    });
  });

  it("returns null when the configured VIN is not on the account", () => {
    expect(
      pickVehicle([{ vin: "5YJSA", display_name: "Model S", state: "online" }], "5YJ3E1EA7MF000000"),
    ).toBeNull();
  });

  it("normalizes Superchargers and ignores destination chargers", () => {
    const observedAt = "2026-08-24T12:05:00.000Z";
    const sites = normalizeFleetSites(payload, observedAt);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      source: "fleet",
      sourceStationId: "4242",
      name: "Bee Cave",
      availableStalls: 2,
      totalStalls: 8,
      occupiedStalls: 6,
      utilizationPct: 75,
      siteClosed: false,
      hardwareGeneration: "unknown",
      amenities: "restrooms,restaurant",
      maxPowerKw: null,
    });
    expect(sites[0]?.congestionSyncAt).toBe("2023-11-14T22:13:20.000Z");
  });
});
