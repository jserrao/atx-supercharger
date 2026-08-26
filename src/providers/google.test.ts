import { describe, expect, it } from "vitest";
import {
  isTeslaSupercharger,
  normalizeGooglePlaces,
  occupancyFromConnectors,
  searchTextBody,
} from "./google";
import type { AppConfig } from "../types";

function config(): AppConfig {
  return {
    collectionIntervalMinutes: 5,
    bbox: { north: 30.5, south: 30.0, west: -98.25, east: -97.7 },
    fleetCount: 50,
    fleetRadius: 80,
    staleThresholdSeconds: 900,
    matchDistanceMeters: 150,
    rawRetentionDays: 14,
    collectorMode: "auto",
    googleFallbackMinutes: 60,
    googleDiscovery: false,
    googlePlacesApiKey: "test",
    teslaAudience: "",
    teslaRedirectUri: "",
    teslaVin: "",
    teslaClientId: "",
    teslaClientSecret: "",
    teslaPublicKey: "",
    adminToken: "",
  };
}

describe("google provider", () => {
  it("searches Tesla Superchargers inside the study bbox", () => {
    expect(searchTextBody(config())).toMatchObject({
      textQuery: "Tesla Supercharger",
      includedType: "electric_vehicle_charging_station",
      locationRestriction: {
        rectangle: {
          low: { latitude: 30.0, longitude: -98.25 },
          high: { latitude: 30.5, longitude: -97.7 },
        },
      },
    });
  });

  it("keeps Supercharger names and drops destination chargers", () => {
    expect(isTeslaSupercharger("Tesla Supercharger")).toBe(true);
    expect(isTeslaSupercharger("Austin Super Charger")).toBe(true);
    expect(isTeslaSupercharger("Tesla Destination Charger")).toBe(false);
  });

  it("does not count out-of-service stalls as occupied", () => {
    const occ = occupancyFromConnectors([
      {
        type: "EV_CONNECTOR_TYPE_NACS",
        count: 12,
        availableCount: 3,
        outOfServiceCount: 2,
        maxChargeRateKw: 250,
        availabilityLastUpdateTime: "2026-08-24T12:00:00Z",
      },
    ]);
    expect(occ).toMatchObject({
      availableStalls: 3,
      totalStalls: 10,
      occupiedStalls: 7,
      utilizationPct: 70,
      outOfServiceStalls: 2,
      siteClosed: false,
    });
  });

  it("marks a fully out-of-service site offline without inventing occupancy", () => {
    const occ = occupancyFromConnectors([
      {
        type: "EV_CONNECTOR_TYPE_TESLA",
        count: 8,
        availableCount: 0,
        outOfServiceCount: 8,
      },
    ]);
    expect(occ.siteClosed).toBe(true);
    expect(occ.availableStalls).toBe(0);
    expect(occ.totalStalls).toBe(8);
    expect(occ.occupiedStalls).toBeNull();
    expect(occ.utilizationPct).toBeNull();
  });

  it("persists sites with no live availableCount instead of skipping them", () => {
    const occ = occupancyFromConnectors([
      { type: "EV_CONNECTOR_TYPE_NACS", count: 16, maxChargeRateKw: 250 },
    ]);
    expect(occ.availableStalls).toBeNull();
    expect(occ.occupiedStalls).toBeNull();
    expect(occ.utilizationPct).toBeNull();
    expect(occ.totalStalls).toBe(16);
    expect(occ.siteClosed).toBeNull();
  });

  it("prefers Tesla/NACS aggregations over CCS", () => {
    const occ = occupancyFromConnectors([
      { type: "EV_CONNECTOR_TYPE_CCS_COMBO_1", count: 2, availableCount: 2 },
      { type: "EV_CONNECTOR_TYPE_NACS", count: 8, availableCount: 1, outOfServiceCount: 1 },
    ]);
    expect(occ.availableStalls).toBe(1);
    expect(occ.totalStalls).toBe(7);
    expect(occ.occupiedStalls).toBe(6);
  });

  it("normalizes Places payloads including offline Superchargers", () => {
    const sites = normalizeGooglePlaces(
      {
        places: [
          {
            id: "places/ChIJ-offline",
            displayName: { text: "Bee Cave Supercharger" },
            location: { latitude: 30.306, longitude: -97.952 },
            evChargeOptions: {
              connectorAggregation: [
                {
                  type: "EV_CONNECTOR_TYPE_TESLA",
                  count: 8,
                  availableCount: 0,
                  outOfServiceCount: 8,
                  availabilityLastUpdateTime: "2026-08-24T11:00:00Z",
                },
              ],
            },
          },
          {
            id: "places/ChIJ-dest",
            displayName: { text: "Hotel Tesla Destination" },
            location: { latitude: 30.3, longitude: -97.8 },
            evChargeOptions: {
              connectorAggregation: [{ type: "EV_CONNECTOR_TYPE_J1772", count: 2, availableCount: 1 }],
            },
          },
          {
            id: "places/ChIJ-unknown",
            displayName: { text: "West Lake Hills Supercharger" },
            location: { latitude: 30.29, longitude: -97.81 },
            evChargeOptions: { connectorAggregation: [{ type: "EV_CONNECTOR_TYPE_NACS", count: 12 }] },
          },
        ],
      },
      "2026-08-24T12:00:00.000Z",
    );

    expect(sites).toHaveLength(2);
    expect(sites[0]).toMatchObject({
      source: "google",
      sourceStationId: "ChIJ-offline",
      siteClosed: true,
      occupiedStalls: null,
      utilizationPct: null,
    });
    expect(sites[1]).toMatchObject({
      sourceStationId: "ChIJ-unknown",
      availableStalls: null,
      totalStalls: 12,
      occupiedStalls: null,
      siteClosed: null,
    });
  });
});
