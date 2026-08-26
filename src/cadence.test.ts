import { describe, expect, it } from "vitest";
import { cadenceBucket } from "./cadence";

describe("cadence", () => {
  it("truncates to the 5-minute bucket", () => {
    expect(cadenceBucket(new Date("2026-08-24T12:07:33.000Z"), 5)).toBe(
      "2026-08-24T12:05:00.000Z",
    );
    expect(cadenceBucket(new Date("2026-08-24T12:00:00.000Z"), 5)).toBe(
      "2026-08-24T12:00:00.000Z",
    );
  });

});
