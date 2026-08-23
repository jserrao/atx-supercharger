import { env } from "cloudflare:workers";

const TOKEN_KEY = "oauth:tokens";
const LOGS_KEY = "experiment:logs";
const MAX_LOGS = 200;
const NEARBY_COUNT = 10;
const NEARBY_RADIUS_MILES = 50;
const TESLA_SCOPES =
  "openid offline_access vehicle_device_data vehicle_location";

const CONDITIONS = {
  driving: "Driving",
  parked_charging: "Parked + charging",
  parked_recent: "Parked + recently active",
  asleep: "Fully asleep",
};

function pemFromEnv(value) {
  if (!value) return "";
  return `${String(value).replace(/\\n/g, "\n").trim()}\n`;
}

const TESLA_PUBLIC_KEY = pemFromEnv(env.TESLA_PUBLIC_KEY);

function json(data, status = 200) {
  return Response.json(data, { status });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function readJson(key, fallback) {
  const raw = await env.KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function teslaTokenRequest(params) {
  const body = new URLSearchParams(params);
  const response = await fetch(
    "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  const payload = await response.json();
  console.log(
    JSON.stringify({
      message: "tesla token response",
      grant_type: params.grant_type,
      status: response.status,
      ok: response.ok,
      keys:
        payload && typeof payload === "object" ? Object.keys(payload) : [],
      error: payload.error ?? null,
    }),
  );
  if (!response.ok) {
    const message =
      payload.error_description || payload.error || JSON.stringify(payload);
    throw new Error(`Tesla token error (${response.status}): ${message}`);
  }
  return payload;
}

async function saveTokens(payload) {
  const tokens = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? null,
    token_type: payload.token_type ?? "Bearer",
    scope: payload.scope ?? TESLA_SCOPES,
    expires_at: Date.now() + Math.max((payload.expires_in ?? 3600) - 60, 30) * 1000,
  };
  await env.KV.put(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

async function getAccessToken() {
  const tokens = await readJson(TOKEN_KEY, null);
  if (!tokens?.access_token) return null;
  if (tokens.expires_at > Date.now()) return tokens.access_token;
  if (!tokens.refresh_token) return null;

  const payload = await teslaTokenRequest({
    grant_type: "refresh_token",
    client_id: env.TESLA_CLIENT_ID,
    refresh_token: tokens.refresh_token,
  });
  const next = await saveTokens(payload);
  return next.access_token;
}

function teslaPathForLog(path) {
  return redactVin(path);
}

async function teslaGet(path) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      method: "GET",
      path,
      data: { error: "not_connected" },
    };
  }

  const response = await fetch(`${env.TESLA_AUDIENCE}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = { error: "non_json_response" };
  }
  return {
    ok: response.ok,
    status: response.status,
    method: "GET",
    path,
    data,
  };
}

function teslaCallLog(result) {
  return redactVin({
    method: result.method ?? "GET",
    path: teslaPathForLog(result.path ?? ""),
    status: result.status,
    ok: result.ok,
    body: result.data,
  });
}

function configuredVin() {
  return String(env.TESLA_VIN ?? "").trim();
}

function redactVin(value) {
  const vin = configuredVin();
  if (!vin) return value;
  if (typeof value === "string") return value.replaceAll(vin, "[vin]");
  if (value && typeof value === "object") {
    try {
      return JSON.parse(redactVin(JSON.stringify(value)));
    } catch {
      return value;
    }
  }
  return value;
}

function publicLog(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const { vin: _vin, ...rest } = entry;
  return redactVin(rest);
}

function pickVehicle(vehicles) {
  const list = Array.isArray(vehicles) ? vehicles : [];
  const vin = configuredVin();
  if (vin) {
    return (
      list.find((vehicle) => vehicle.vin === vin) ?? {
        vin,
        display_name: "Model 3",
        state: null,
      }
    );
  }
  return (
    list.find((vehicle) => String(vehicle.vin ?? "").startsWith("5YJ3")) ||
    list.find((vehicle) =>
      String(vehicle.display_name ?? "").toLowerCase().includes("model 3"),
    ) ||
    list[0] ||
    null
  );
}

function summarizeSites(payload) {
  const body = payload?.response ?? payload ?? {};
  const superchargers = Array.isArray(body.superchargers)
    ? body.superchargers
    : [];
  const destination = Array.isArray(body.destination_charging)
    ? body.destination_charging
    : [];

  const mapSite = (site, type) => ({
    type,
    name: site.name ?? null,
    distance_miles: site.distance_miles ?? null,
    available_stalls: site.available_stalls ?? null,
    total_stalls: site.total_stalls ?? null,
    site_closed: site.site_closed ?? null,
  });

  return {
    supercharger_count: superchargers.length,
    destination_count: destination.length,
    available_stalls_total: superchargers.reduce(
      (sum, site) => sum + (Number(site.available_stalls) || 0),
      0,
    ),
    sites: [
      ...superchargers.slice(0, 15).map((site) => mapSite(site, "supercharger")),
      ...destination.slice(0, 5).map((site) => mapSite(site, "destination")),
    ],
  };
}

async function appendLog(entry) {
  const logs = await readJson(LOGS_KEY, []);
  logs.unshift(entry);
  await env.KV.put(LOGS_KEY, JSON.stringify(logs.slice(0, MAX_LOGS)));
}

async function handleLogin() {
  const state = crypto.randomUUID();
  await env.KV.put(`oauth:state:${state}`, "1", { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.TESLA_CLIENT_ID,
    locale: "en-US",
    prompt: "login",
    redirect_uri: env.TESLA_REDIRECT_URI,
    response_type: "code",
    scope: TESLA_SCOPES,
    state,
  });
  return Response.redirect(
    `https://auth.tesla.com/oauth2/v3/authorize?${params}`,
    302,
  );
}

async function handleCallback(url) {
  const error = url.searchParams.get("error");
  if (error) {
    return html(
      renderPage({
        connected: false,
        notice: `Tesla authorization failed: ${error}`,
      }),
      400,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return text("Missing OAuth code or state", 400);
  }

  const expected = await env.KV.get(`oauth:state:${state}`);
  if (!expected) {
    return text("Invalid or expired OAuth state", 400);
  }
  await env.KV.delete(`oauth:state:${state}`);

  const payload = await teslaTokenRequest({
    grant_type: "authorization_code",
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    code,
    audience: env.TESLA_AUDIENCE,
    redirect_uri: env.TESLA_REDIRECT_URI,
  });
  await saveTokens(payload);
  return Response.redirect(new URL("/", url).toString(), 302);
}

async function handleSample(request) {
  let condition = "";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    condition = String(body.condition ?? "");
  } else {
    const form = await request.formData();
    condition = String(form.get("condition") ?? "");
  }

  if (!CONDITIONS[condition]) {
    return text("Unknown vehicle condition", 400);
  }

  const started = Date.now();
  const vehiclesResult = await teslaGet("/api/1/vehicles");
  if (vehiclesResult.status === 401) {
    return Response.redirect(new URL("/auth/login", request.url).toString(), 302);
  }

  const vehicle = pickVehicle(vehiclesResult.data?.response);
  if (!vehicle?.vin) {
    return html(
      renderPage({
        connected: true,
        notice: "Vehicle is not configured on this Worker.",
        logs: (await readJson(LOGS_KEY, [])).map(publicLog),
      }),
      404,
    );
  }

  const nearby = await teslaGet(
    `/api/1/vehicles/${encodeURIComponent(vehicle.vin)}/nearby_charging_sites?count=${NEARBY_COUNT}&radius=${NEARBY_RADIUS_MILES}&detail=true`,
  );
  const summary = nearby.ok ? summarizeSites(nearby.data) : null;
  const tesla_calls = [
    teslaCallLog(vehiclesResult),
    teslaCallLog(nearby),
  ];
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    condition,
    condition_label: CONDITIONS[condition],
    vehicle_name: vehicle.display_name ?? null,
    tesla_state: vehicle.state ?? null,
    nearby_ok: nearby.ok,
    nearby_status: nearby.status,
    nearby_error: nearby.ok
      ? null
      : redactVin(nearby.data?.error || nearby.data?.response || nearby.data),
    latency_ms: Date.now() - started,
    tesla_calls,
    ...summary,
  };
  await appendLog(entry);

  console.log(
    JSON.stringify({
      message: "tesla sample",
      condition,
      tesla_state: entry.tesla_state,
      nearby_ok: entry.nearby_ok,
      nearby_status: entry.nearby_status,
      supercharger_count: entry.supercharger_count ?? null,
      tesla_calls,
    }),
  );

  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json") || contentType.includes("application/json")) {
    return json(publicLog(entry), nearby.ok ? 200 : 502);
  }

  return Response.redirect(new URL("/?sampled=1", request.url).toString(), 303);
}

function renderPage({
  connected,
  vehicle = null,
  logs = [],
  notice = "",
} = {}) {
  const vehicleLine = vehicle
    ? `${escapeHtml(vehicle.display_name ?? "Tesla")} · Tesla state: ${escapeHtml(vehicle.state ?? "unknown")}`
    : connected
      ? "Connected, but the configured vehicle was not on this account."
      : "Not connected. This app needs your Tesla account login — partner tokens cannot see the car.";

  const buttons = Object.entries(CONDITIONS)
    .map(
      ([value, label]) => `
        <form method="post" action="/experiment/sample">
          <input type="hidden" name="condition" value="${value}">
          <button type="submit"${connected && vehicle ? "" : " disabled"}>${escapeHtml(label)}</button>
        </form>`,
    )
    .join("");

  const rows = logs
    .slice(0, 40)
    .map((entry) => {
      const ok = entry.nearby_ok ? "yes" : "no";
      const sites = entry.nearby_ok
        ? `${entry.supercharger_count ?? 0} SC / ${entry.destination_count ?? 0} dest`
        : escapeHtml(
            typeof entry.nearby_error === "string"
              ? entry.nearby_error
              : JSON.stringify(entry.nearby_error ?? entry.nearby_status),
          );
      return `<tr>
        <td>${escapeHtml(entry.at)}</td>
        <td>${escapeHtml(entry.condition_label ?? entry.condition)}</td>
        <td>${escapeHtml(entry.tesla_state)}</td>
        <td>${ok} (${escapeHtml(entry.nearby_status)})</td>
        <td>${sites}</td>
        <td>${escapeHtml(entry.latency_ms)}ms</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATX Supercharger experiment</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 1.5rem auto; max-width: 52rem; line-height: 1.4; padding: 0 1rem; }
    h1 { font-size: 1.4rem; }
    .row { display: grid; gap: .6rem; grid-template-columns: 1fr 1fr; margin: 1rem 0; }
    button, .link { width: 100%; min-height: 3rem; font: inherit; padding: .6rem .8rem; }
    .note { background: #f3f3f3; padding: .8rem 1rem; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { border-bottom: 1px solid #ccc; padding: .45rem .3rem; text-align: left; vertical-align: top; }
    a { color: inherit; }
    @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Nearby Supercharger experiment</h1>
  <p>Does <code>nearby_charging_sites</code> work without a live <code>vehicle_data</code> wake?</p>
  <p>${vehicleLine}</p>
  ${notice ? `<p class="note">${escapeHtml(notice)}</p>` : ""}
  <p>
    ${connected ? `<a class="link" href="/auth/logout">Disconnect</a>` : `<a class="link" href="/auth/login">Connect Tesla account</a>`}
  </p>
  <p>Label the car’s actual condition, then sample. This call does not send <code>wake_up</code> or <code>vehicle_data</code>.</p>
  <div class="row">${buttons}</div>
  <h2>Log</h2>
  <table>
    <thead>
      <tr>
        <th>When</th>
        <th>Labeled condition</th>
        <th>Tesla state</th>
        <th>Nearby sites?</th>
        <th>Sites / error</th>
        <th>Latency</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="6">No samples yet.</td></tr>`}
    </tbody>
  </table>
  <p><a href="/experiment/logs">JSON logs</a></p>
</body>
</html>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (
        url.pathname ===
        "/.well-known/appspecific/com.tesla.3p.public-key.pem"
      ) {
        const pem = TESLA_PUBLIC_KEY;
        if (!pem.includes("BEGIN PUBLIC KEY")) {
          return text("TESLA_PUBLIC_KEY is missing or invalid\n", 500);
        }
        return new Response(pem, {
          headers: { "content-type": "application/x-pem-file; charset=utf-8" },
        });
      }

      if (url.pathname === "/auth/login") {
        return handleLogin();
      }

      if (url.pathname === "/auth/callback") {
        return handleCallback(url);
      }

      if (url.pathname === "/auth/logout") {
        await env.KV.delete(TOKEN_KEY);
        return Response.redirect(new URL("/", url).toString(), 302);
      }

      if (url.pathname === "/experiment/sample" && request.method === "POST") {
        return handleSample(request);
      }

      if (url.pathname === "/experiment/logs") {
        const logs = await readJson(LOGS_KEY, []);
        return json(logs.map(publicLog));
      }

      if (url.pathname !== "/") {
        return text("Not found", 404);
      }

      const accessToken = await getAccessToken();
      const connected = Boolean(accessToken);
      let vehicle = null;
      if (connected) {
        const vehiclesResult = await teslaGet("/api/1/vehicles");
        vehicle = pickVehicle(vehiclesResult.data?.response);
      }
      const notice =
        url.searchParams.get("sampled") === "1"
          ? "Sample saved. Repeat in the other vehicle conditions."
          : "";
      return html(
        renderPage({
          connected,
          vehicle,
          logs: (await readJson(LOGS_KEY, [])).map(publicLog),
          notice,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "unhandled error", error: message, path: url.pathname }));
      return text(message, 500);
    }
  },
};
