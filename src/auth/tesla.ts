import type { AppConfig, TeslaHttpResult } from "../types";
import { logInfo } from "../log";

export const TOKEN_KEY = "oauth:tokens";
export const TESLA_SCOPES = "openid offline_access vehicle_device_data";

type TokenBlob = {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  scope: string;
  expires_at: number;
};

let memoryTokens: TokenBlob | null = null;

async function readJson<T>(kv: KVNamespace, key: string, fallback: T): Promise<T> {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function pemFromEnv(value: string | undefined): string {
  if (!value) return "";
  return `${String(value).replace(/\\n/g, "\n").trim()}\n`;
}

export function clearTokenCache(): void {
  memoryTokens = null;
}

async function teslaTokenRequest(
  config: AppConfig,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch("https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  logInfo(config.teslaVin, {
    message: "tesla token response",
    grant_type: params.grant_type,
    status: response.status,
    ok: response.ok,
    keys: Object.keys(payload),
    error: payload.error ?? null,
  });
  if (!response.ok) {
    const message =
      String(payload.error_description || payload.error || JSON.stringify(payload));
    throw new Error(`Tesla token error (${response.status}): ${message}`);
  }
  return payload;
}

export async function saveTokens(
  env: Env,
  config: AppConfig,
  payload: Record<string, unknown>,
): Promise<TokenBlob> {
  const expiresIn = Number(payload.expires_in ?? 3600);
  const tokens: TokenBlob = {
    access_token: String(payload.access_token),
    refresh_token: payload.refresh_token ? String(payload.refresh_token) : null,
    token_type: String(payload.token_type ?? "Bearer"),
    scope: String(payload.scope ?? TESLA_SCOPES),
    expires_at: Date.now() + Math.max(expiresIn - 60, 30) * 1000,
  };
  memoryTokens = tokens;
  await env.KV.put(TOKEN_KEY, JSON.stringify(tokens));
  logInfo(config.teslaVin, { message: "tesla tokens saved", expires_at: tokens.expires_at });
  return tokens;
}

export async function getAccessToken(
  env: Env,
  config: AppConfig,
  forceRefresh = false,
): Promise<string | null> {
  if (!forceRefresh && memoryTokens?.access_token && memoryTokens.expires_at > Date.now()) {
    return memoryTokens.access_token;
  }

  const tokens =
    !forceRefresh && memoryTokens
      ? memoryTokens
      : await readJson<TokenBlob | null>(env.KV, TOKEN_KEY, null);
  if (!tokens?.access_token) {
    memoryTokens = null;
    return null;
  }
  memoryTokens = tokens;
  if (!forceRefresh && tokens.expires_at > Date.now()) return tokens.access_token;
  if (!tokens.refresh_token) return forceRefresh ? null : tokens.access_token;

  const payload = await teslaTokenRequest(config, {
    grant_type: "refresh_token",
    client_id: config.teslaClientId,
    refresh_token: tokens.refresh_token,
  });
  if (!payload.refresh_token) payload.refresh_token = tokens.refresh_token;
  const next = await saveTokens(env, config, payload);
  return next.access_token;
}

export async function exchangeAuthorizationCode(
  env: Env,
  config: AppConfig,
  code: string,
): Promise<void> {
  const payload = await teslaTokenRequest(config, {
    grant_type: "authorization_code",
    client_id: config.teslaClientId,
    client_secret: config.teslaClientSecret,
    code,
    audience: config.teslaAudience,
    redirect_uri: config.teslaRedirectUri,
  });
  await saveTokens(env, config, payload);
}

export async function teslaGet(
  env: Env,
  config: AppConfig,
  path: string,
  retried = false,
): Promise<TeslaHttpResult> {
  const accessToken = await getAccessToken(env, config);
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      method: "GET",
      path,
      data: { error: "not_connected" },
    };
  }

  const response = await fetch(`${config.teslaAudience}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = { error: "non_json_response" };
  }

  if (response.status === 401 && !retried) {
    const refreshed = await getAccessToken(env, config, true);
    if (refreshed) return teslaGet(env, config, path, true);
  }

  return {
    ok: response.ok,
    status: response.status,
    method: "GET",
    path,
    data,
  };
}
