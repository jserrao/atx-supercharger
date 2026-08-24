const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "client_secret",
  "authorization",
  "vin",
  "id_s",
]);

export function configuredVin(envVin: string | undefined): string {
  return String(envVin ?? "").trim();
}

export function redactVin(value: unknown, vin: string): unknown {
  if (!vin) return value;
  if (typeof value === "string") return value.replaceAll(vin, "[vin]");
  if (value && typeof value === "object") {
    try {
      return JSON.parse(redactVin(JSON.stringify(value), vin) as string);
    } catch {
      return value;
    }
  }
  return value;
}

export function sanitizeRaw(value: unknown, vin: string): unknown {
  const stripped = stripSensitive(value);
  return redactVin(stripped, vin);
}

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripSensitive(nested);
  }
  return out;
}

export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
