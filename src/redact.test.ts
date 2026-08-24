import { describe, expect, it } from "vitest";
import { redactVin, sanitizeRaw } from "./redact";

describe("redact", () => {
  it("strips the VIN from nested payloads", () => {
    const vin = "5YJ3E1EA7MF000000";
    const redacted = redactVin(
      { path: `/api/1/vehicles/${vin}/nearby_charging_sites`, vin },
      vin,
    );
    expect(JSON.stringify(redacted)).not.toContain(vin);
    expect(redacted).toEqual({
      path: "/api/1/vehicles/[vin]/nearby_charging_sites",
      vin: "[vin]",
    });
  });

  it("drops tokens and vin keys from raw payloads", () => {
    const vin = "5YJ3E1EA7MF000000";
    const sanitized = sanitizeRaw(
      {
        access_token: "secret",
        refresh_token: "secret2",
        vin,
        sites: [{ name: "Bee Cave", vin }],
      },
      vin,
    );
    expect(JSON.stringify(sanitized)).not.toContain("secret");
    expect(JSON.stringify(sanitized)).not.toContain(vin);
    expect(sanitized).toEqual({ sites: [{ name: "Bee Cave" }] });
  });
});
