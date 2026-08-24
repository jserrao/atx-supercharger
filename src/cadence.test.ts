import { describe, expect, it } from "vitest";
import { cadenceBucket, shouldRunDual } from "./cadence";

describe("cadence", () => {
  it("truncates to the 5-minute bucket", () => {
    expect(cadenceBucket(new Date("2026-08-24T12:07:33.000Z"), 5)).toBe(
      "2026-08-24T12:05:00.000Z",
    );
    expect(cadenceBucket(new Date("2026-08-24T12:00:00.000Z"), 5)).toBe(
      "2026-08-24T12:00:00.000Z",
    );
  });

  it("runs dual validation on :00 and :30 UTC", () => {
    expect(shouldRunDual(new Date("2026-08-24T12:00:00.000Z"))).toBe(true);
    expect(shouldRunDual(new Date("2026-08-24T12:30:00.000Z"))).toBe(true);
    expect(shouldRunDual(new Date("2026-08-24T12:05:00.000Z"))).toBe(false);
  });
});
