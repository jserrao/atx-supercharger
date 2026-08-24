import { describe, expect, it } from "vitest";
import {
  haversineMeters,
  inBbox,
  namesReasonablyMatch,
  normalizeStationName,
  versionTag,
} from "./geo";

const bbox = { north: 30.5, south: 30.0, west: -98.25, east: -97.7 };

describe("geo", () => {
  it("treats Bee Cave as inside the study bbox and Houston as outside", () => {
    expect(inBbox(30.306, -97.952, bbox)).toBe(true);
    expect(inBbox(29.76, -95.37, bbox)).toBe(false);
  });

  it("measures nearby Superchargers in meters", () => {
    const meters = haversineMeters(30.306, -97.952, 30.307, -97.952);
    expect(meters).toBeGreaterThan(90);
    expect(meters).toBeLessThan(130);
  });

  it("does not match V3 and V4 names", () => {
    expect(versionTag("Austin Supercharger V3")).toBe("v3");
    expect(namesReasonablyMatch("Austin Supercharger V3", "Austin Supercharger V4")).toBe(false);
  });

  it("matches shortened and full west-Austin names", () => {
    expect(normalizeStationName("Tesla Supercharger - Bee Cave")).toBe("bee cave");
    expect(namesReasonablyMatch("Bee Cave", "Austin - Bee Cave")).toBe(true);
  });
});
