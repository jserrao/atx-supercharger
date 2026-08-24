import { describe, expect, it } from "vitest";
import { inferHardwareGeneration, siteHardwareFromRaw } from "./hardware";

describe("hardware generation", () => {
  it("prefers an explicit version in the site name", () => {
    expect(inferHardwareGeneration("Austin Supercharger V4", 250)).toBe("v4");
    expect(inferHardwareGeneration("Austin V3", 150)).toBe("v3");
    expect(inferHardwareGeneration("Austin V2", null)).toBe("v2");
  });

  it("does not pretend 250 kW is definitely V3", () => {
    expect(inferHardwareGeneration("Bee Cave", 250)).toBe("v3_or_v4");
    expect(inferHardwareGeneration("Bee Cave", 150)).toBe("v2");
    expect(inferHardwareGeneration("Bee Cave", 325)).toBe("v4");
    expect(inferHardwareGeneration("Bee Cave", null)).toBe("unknown");
  });

  it("reads power and amenities from a Fleet-shaped site", () => {
    expect(
      siteHardwareFromRaw(
        {
          name: "Bee Cave",
          amenities: "restrooms,restaurant",
          billing_info: "",
          max_power_kw: 250,
        },
        "Bee Cave",
      ),
    ).toEqual({
      maxPowerKw: 250,
      hardwareGeneration: "v3_or_v4",
      amenities: "restrooms,restaurant",
      billingInfo: null,
    });
  });
});
