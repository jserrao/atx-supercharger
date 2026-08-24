import { loadConfig } from "./config";
import { runCollection } from "./collector";
import { healthPayload } from "./health";
import { requireAdmin } from "./admin";
import {
  TOKEN_KEY,
  TESLA_SCOPES,
  exchangeAuthorizationCode,
  pemFromEnv,
} from "./auth/tesla";
import { logError } from "./log";

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

async function handleLogin(env: Env, config: ReturnType<typeof loadConfig>): Promise<Response> {
  const state = crypto.randomUUID();
  await env.KV.put(`oauth:state:${state}`, "1", { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: config.teslaClientId,
    locale: "en-US",
    prompt: "login",
    redirect_uri: config.teslaRedirectUri,
    response_type: "code",
    scope: TESLA_SCOPES,
    state,
  });
  return Response.redirect(`https://auth.tesla.com/oauth2/v3/authorize?${params}`, 302);
}

async function handleCallback(
  env: Env,
  config: ReturnType<typeof loadConfig>,
  url: URL,
): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) return text(`Tesla authorization failed: ${error}`, 400);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return text("Missing OAuth code or state", 400);

  const expected = await env.KV.get(`oauth:state:${state}`);
  if (!expected) return text("Invalid or expired OAuth state", 400);
  await env.KV.delete(`oauth:state:${state}`);

  await exchangeAuthorizationCode(env, config, code);
  return text("Tesla account connected. Collector will use this token on the next poll.\n");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const config = loadConfig(env);

    try {
      if (url.pathname === "/.well-known/appspecific/com.tesla.3p.public-key.pem") {
        const pem = pemFromEnv(config.teslaPublicKey);
        if (!pem.includes("BEGIN PUBLIC KEY")) {
          return text("TESLA_PUBLIC_KEY is missing or invalid\n", 500);
        }
        return new Response(pem, {
          headers: { "content-type": "application/x-pem-file; charset=utf-8" },
        });
      }

      if (url.pathname === "/auth/login") {
        return handleLogin(env, config);
      }

      if (url.pathname === "/auth/callback") {
        return handleCallback(env, config, url);
      }

      if (url.pathname === "/auth/logout") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        await env.KV.delete(TOKEN_KEY);
        return text("Disconnected.\n");
      }

      if (url.pathname === "/health") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        const hours = Number(url.searchParams.get("hours") ?? 24);
        return Response.json(await healthPayload(env, new Date(), hours));
      }

      if (url.pathname === "/collect" && request.method === "POST") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        let forceSource: "fleet" | "graphql" | "auto" | undefined;
        if ((request.headers.get("content-type") ?? "").includes("application/json")) {
          const body = (await request.json()) as { force_source?: string };
          if (
            body.force_source === "fleet" ||
            body.force_source === "graphql" ||
            body.force_source === "auto"
          ) {
            forceSource = body.force_source;
          }
        }
        const result = await runCollection(env, { force: true, forceSource });
        const ok = result.status === "success" || result.status === "fleet_vehicle_offline" || result.status === "fleet_out_of_region";
        return Response.json(result, { status: ok ? 200 : 502 });
      }

      if (url.pathname === "/") {
        return Response.json({
          service: "atx-supercharger-collector",
          docs: "Headless collector. Use /auth/login to connect Tesla. /health and /collect require COLLECTOR_ADMIN_TOKEN.",
        });
      }

      return text("Not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(config.teslaVin, {
        message: "unhandled error",
        error: message,
        path: url.pathname,
      });
      return text("Internal server error", 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runCollection(env);
  },
} satisfies ExportedHandler<Env>;
