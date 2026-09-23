import { describe, expect, it } from "vitest";
import type { AppConfig } from "./types";
import { inWakeHours, shouldWakeForOccupancy, zonedClock } from "./wake";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
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
    wakeWhenAsleep: true,
    wakeTimezone: "America/Chicago",
    wakeStartHour: 8,
    wakeEndHour: 15,
    wakeTimeoutSeconds: 48,
    wakePollSeconds: 8,
    ...overrides,
  };
}

describe("wake window", () => {
  it("maps UTC cadence buckets onto America/Chicago hours", () => {
    expect(zonedClock(new Date("2026-09-01T13:00:00.000Z"), "America/Chicago")).toEqual({
      hour: 8,
      minute: 0,
    });
    expect(zonedClock(new Date("2026-01-01T14:00:00.000Z"), "America/Chicago")).toEqual({
      hour: 8,
      minute: 0,
    });
  });

  it("uses a half-open local hour range", () => {
    expect(inWakeHours(7, 8, 15)).toBe(false);
    expect(inWakeHours(8, 8, 15)).toBe(true);
    expect(inWakeHours(14, 8, 15)).toBe(true);
    expect(inWakeHours(15, 8, 15)).toBe(false);
  });

  it("wakes only at the top of local hours inside the window", () => {
    const cfg = config();
    expect(shouldWakeForOccupancy(cfg, new Date("2026-09-01T13:00:00.000Z"))).toBe(true);
    expect(shouldWakeForOccupancy(cfg, new Date("2026-09-01T13:05:00.000Z"))).toBe(false);
    expect(shouldWakeForOccupancy(cfg, new Date("2026-09-01T12:00:00.000Z"))).toBe(false);
    expect(shouldWakeForOccupancy(cfg, new Date("2026-09-01T19:00:00.000Z"))).toBe(true);
    expect(shouldWakeForOccupancy(cfg, new Date("2026-09-01T20:00:00.000Z"))).toBe(false);
  });

  it("skips the window when disabled, and ignores it for forced fleet", () => {
    const off = config({ wakeWhenAsleep: false });
    expect(shouldWakeForOccupancy(off, new Date("2026-09-01T13:00:00.000Z"))).toBe(false);
    expect(shouldWakeForOccupancy(off, new Date("2026-09-01T13:05:00.000Z"), true)).toBe(true);
  });
});
