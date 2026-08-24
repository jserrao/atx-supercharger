const LAST_SUCCESS = "collector:last_success";
const LAST_FLEET = "collector:last_fleet_success";
const LAST_GRAPHQL = "collector:last_graphql_success";
const LOCK_KEY = "collector:lock";

export async function readKvJson<T>(kv: KVNamespace, key: string, fallback: T): Promise<T> {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function acquireLock(
  kv: KVNamespace,
  bucket: string,
  ttlSeconds: number,
): Promise<boolean> {
  const current = await kv.get(LOCK_KEY);
  if (current && current !== bucket) return false;
  await kv.put(LOCK_KEY, bucket, { expirationTtl: ttlSeconds });
  return true;
}

export async function releaseLock(kv: KVNamespace, bucket: string): Promise<void> {
  const current = await kv.get(LOCK_KEY);
  if (current === bucket) await kv.delete(LOCK_KEY);
}

export async function recordSuccess(
  kv: KVNamespace,
  source: "fleet" | "graphql" | "any",
  at: string,
): Promise<void> {
  if (source === "any" || source === "fleet" || source === "graphql") {
    await kv.put(LAST_SUCCESS, at);
  }
  if (source === "fleet") await kv.put(LAST_FLEET, at);
  if (source === "graphql") await kv.put(LAST_GRAPHQL, at);
}

export async function readCollectorMarkers(kv: KVNamespace): Promise<{
  lastSuccess: string | null;
  lastFleetSuccess: string | null;
  lastGraphqlSuccess: string | null;
}> {
  const [lastSuccess, lastFleetSuccess, lastGraphqlSuccess] = await Promise.all([
    kv.get(LAST_SUCCESS),
    kv.get(LAST_FLEET),
    kv.get(LAST_GRAPHQL),
  ]);
  return { lastSuccess, lastFleetSuccess, lastGraphqlSuccess };
}
