import { asFiniteNumber } from "./observations";
import type { HardwareGeneration } from "./types";

export type { HardwareGeneration };

export type SiteHardware = {
  maxPowerKw: number | null;
  hardwareGeneration: HardwareGeneration;
  amenities: string | null;
  billingInfo: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function textOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractMaxPowerKw(site: unknown): number | null {
  const record = asRecord(site);
  const nested = asRecord(record.location);
  return asFiniteNumber(
    record.max_power_kw ??
      record.maxPowerKw ??
      record.max_electric_power ??
      record.maxElectricPower ??
      record.power_kw ??
      record.powerKw ??
      nested.max_power_kw ??
      nested.maxPowerKw,
  );
}

export function generationFromName(name: string | null | undefined): HardwareGeneration | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (/\bv4\b/.test(lower)) return "v4";
  if (/\bv3\.5\b/.test(lower) || /\bv3\b/.test(lower)) return "v3";
  if (/\bv2\b/.test(lower)) return "v2";
  return null;
}

export function generationFromPowerKw(maxPowerKw: number | null): HardwareGeneration | null {
  if (maxPowerKw == null) return null;
  if (maxPowerKw <= 150) return "v2";
  if (maxPowerKw >= 300) return "v4";
  if (maxPowerKw >= 200) return "v3_or_v4";
  return null;
}

export function inferHardwareGeneration(
  name: string | null | undefined,
  maxPowerKw: number | null,
): HardwareGeneration {
  return generationFromName(name) ?? generationFromPowerKw(maxPowerKw) ?? "unknown";
}

export function siteHardwareFromRaw(site: unknown, name: string): SiteHardware {
  const record = asRecord(site);
  const location = asRecord(record.location);
  const maxPowerKw = extractMaxPowerKw(site);
  return {
    maxPowerKw,
    hardwareGeneration: inferHardwareGeneration(name, maxPowerKw),
    amenities: textOrNull(record.amenities ?? location.amenities),
    billingInfo: textOrNull(record.billing_info ?? record.billingInfo),
  };
}
