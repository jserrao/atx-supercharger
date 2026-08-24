import type { BoundingBox } from "./types";

const EARTH_RADIUS_M = 6_371_000;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function inBbox(lat: number, lon: number, bbox: BoundingBox): boolean {
  return lat <= bbox.north && lat >= bbox.south && lon >= bbox.west && lon <= bbox.east;
}

export function versionTag(name: string): string | null {
  const match = name.toLowerCase().match(/\bv[2-4]\b/);
  return match ? match[0] : null;
}

export function normalizeStationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/supercharger/g, "")
    .replace(/tesla/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function namesReasonablyMatch(a: string, b: string): boolean {
  const va = versionTag(a);
  const vb = versionTag(b);
  if (va && vb && va !== vb) return false;

  const na = normalizeStationName(a);
  const nb = normalizeStationName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const tokensA = na.split(" ").filter(Boolean);
  const tokensB = nb.split(" ").filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const setB = new Set(tokensB);
  let overlap = 0;
  for (const token of tokensA) {
    if (setB.has(token)) overlap += 1;
  }
  const min = Math.min(tokensA.length, tokensB.length);
  return overlap / min >= 0.6;
}
