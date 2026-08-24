import { describe, expect, it } from "vitest";
import { normalizeGraphqlSites } from "./graphql";

describe("graphql provider", () => {
  it("normalizes nearby Superchargers from the charging GraphQL payload", () => {
    const payload = {
      data: {
        charging: {
          nearbySites: {
            sitesAndDistances: [
              {
                haversineDistanceMiles: 1.2,
                location: {
                  id: "sc-1",
                  localizedSiteName: "Dripping Springs",
                  availableStalls: 6,
                  totalStalls: 12,
                  maxPowerKw: 250,
                  siteType: "SUPERCHARGER",
                  centroid: { latitude: 30.19, longitude: -98.08 },
                  activeOutages: [],
                },
              },
              {
                location: {
                  id: "dest-1",
                  localizedSiteName: "Hotel",
                  availableStalls: 1,
                  totalStalls: 2,
                  siteType: "DESTINATION",
                  centroid: { latitude: 30.2, longitude: -98.0 },
                },
              },
            ],
          },
        },
      },
    };

    const sites = normalizeGraphqlSites(payload, "2026-08-24T12:00:00.000Z");
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      source: "graphql",
      sourceStationId: "sc-1",
      name: "Dripping Springs",
      availableStalls: 6,
      occupiedStalls: 6,
      utilizationPct: 50,
      siteClosed: false,
      maxPowerKw: 250,
      hardwareGeneration: "v3_or_v4",
    });
  });
});
