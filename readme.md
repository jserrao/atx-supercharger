# ATX Supercharger collector

Headless Cloudflare Worker that records Tesla Supercharger utilization in western and southwest Austin every five minutes.

Fleet API is the live occupancy source while the associated vehicle is online. Tesla does not offer a supported bbox occupancy API without an awake vehicle. When the vehicle is asleep, offline, returns `408`, or reports no in-bbox Superchargers, Google Places API (New) fills occupancy at most once per `GOOGLE_FALLBACK_MINUTES` (default 60). The collector never calls `wake_up` or `vehicle_data`.

Tesla GraphQL is gone. Historical `source = graphql` sample rows are kept for provenance.

KV is used only for Tesla OAuth tokens and login state. Poll locks, success markers, and Google cooldown live in D1 so the collector does not burn the Workers KV daily write quota.

## Data capture

Every cron tick writes a `poll_runs` row, even when the car is asleep and Google is on cooldown. That is how “no demand” is distinguished from “no observation.”

### `poll_runs` — one row per scheduled interval

| Field | Captures |
|---|---|
| `scheduled_at` | Cadence bucket (unique). Source of scheduled vs actual coverage. |
| `started_at` / `completed_at` | Wall clock for the attempt |
| `vehicle_state` | Tesla `online` / `asleep` / `offline` from `GET /vehicles` |
| `source_used` | `fleet` or `google` when samples were persisted |
| `fleet_status` / `google_status` | HTTP status from each provider |
| `google_requests` | Places `searchText` HTTP calls this interval (including 5xx retry / extra pages) |
| `sample_count` | In-bbox Superchargers stored for this interval |
| `latency_ms` | End-to-end collector duration |
| `status` | Outcome (see below) |
| `error` | Safe, VIN-redacted error string |

Statuses:

- `success` / `partial_success` — charger observations stored
- `google_cooldown` — vehicle could not serve Fleet occupancy; Google interval has not elapsed
- `fleet_vehicle_offline` — car asleep/offline and Google is not enabled (`fleet_only`)
- `fleet_out_of_region` — Fleet returned sites, none in the study bbox, Google not enabled
- `fleet_error` / `google_error` / `google_auth_failure` / `google_rate_limited` / `rate_limited` / `not_connected` / `no_data` — failed collection

`google_cooldown` is expected while the car sleeps. It is not a failed poll.

### `station_samples` — one row per station per successful poll

| Field | Type | Captures |
|---|---|---|
| `scheduled_at` | TEXT | Polling interval (5-minute cadence bucket). Use this for time series. |
| `polled_at` | TEXT | Wall-clock time the collector captured this sample |
| `observed_at` | TEXT | Same instant as `polled_at` |
| `available_stalls` | INTEGER | Open stalls. Null when the provider sent no live availability. |
| `total_stalls` | INTEGER | Usable stall count (Google: `count - outOfServiceCount`). Physical count when the site is fully out of service. |
| `occupied_stalls` | INTEGER | `usable - available` when both are known. Null when availability is missing or the site is offline. |
| `utilization_pct` | REAL | `occupied / usable * 100`. Null when occupancy is unknown. |
| `station_id` | TEXT | Canonical UUID |
| `station_name` | TEXT | Display name at sample time |
| `source_station_id` | TEXT | Tesla Fleet ID or Google Place ID at sample time |
| `source` | TEXT | `fleet` or `google` (historical rows may be `graphql`) |
| `site_closed` | INTEGER | 1 when Tesla marks the site closed, or Google reports no usable stalls (offline) |
| `congestion_sync_at` | TEXT | Tesla `congestion_sync_time_utc_secs` or Google `availabilityLastUpdateTime` |
| `congestion_age_seconds` | INTEGER | Age of provider occupancy data vs poll |
| `is_stale` | INTEGER | 1 if congestion age > `STALE_THRESHOLD_SECONDS` (default 15 minutes) |
| `max_power_kw` | INTEGER | When the provider sends it |
| `hardware_generation` | TEXT | Inferred V2/V3/V4; often `unknown` on Fleet-only payloads |
| `amenities` | TEXT | Site amenities string |
| `billing_info` | TEXT | Fleet billing blob when present |

Samples outside the configured bounding box are discarded. Destination chargers are not stored as samples.

Google sites with missing `availableCount` or fully out-of-service stalls **are stored**. Occupancy is left null rather than invented. `site_closed = 1` means the site has no usable stalls.

### `stations` — canonical site list

UUID plus `fleet_id`, `graphql_id` (historical), `google_place_id`, name, coordinates, latest stall count, power, hardware generation, and amenities. Matching is provider ID first, then coordinates + name within `MATCH_DISTANCE_METERS` (150). Name is never the permanent key.

With `GOOGLE_DISCOVERY=false` (default), unmatched Google places are ignored so Destination Chargers and dealers do not create stations.

### `raw_responses`

Sanitized provider JSON for debugging (VIN/tokens stripped), pruned after `RAW_RETENTION_DAYS`.

## Collection health

`GET /health` (admin token) returns rolling metrics. Default window is 24 hours; pass `?hours=48` up to 168.

```text
coverage_pct = successful_polls / scheduled_polls × 100
```

`successful_polls` are intervals with `status` `success` or `partial_success` (charger data stored). `scheduled_polls` is the number of cadence buckets in the window (288 at a 5-minute interval over 24 hours).

Hourly Google cannot fill 5-minute buckets. While the car sleeps, expect about one stored sample per twelve cron ticks. `coverage.invocation_pct` is the check that cron is firing. `polls.google_cooldown` is expected, not a failure.

| Metric | JSON path | Meaning |
|---|---|---|
| Scheduled polls | `coverage.scheduled_polls` | Expected cron buckets in the window |
| Successful polls | `coverage.successful_polls` | Intervals that stored Supercharger samples |
| Coverage % | `coverage.coverage_pct` | Successful / scheduled |
| Invocations | `coverage.invocations` | `poll_runs` rows actually written |
| Fleet polls | `polls.fleet` | Intervals persisted from Fleet |
| Google polls | `polls.google` | Intervals persisted from Google |
| Google cooldown | `polls.google_cooldown` | Offline/408 ticks skipped because Google is not due |
| Google API calls | `polls.google_requests` | Sum of Places HTTP calls in the window |
| Failed polls | `polls.failed` | API/auth/rate-limit/no-data errors |
| Average latency | `polls.avg_latency_ms` | Mean `poll_runs.latency_ms` |
| Stations per poll | `polls.avg_stations_per_poll` | Mean `sample_count`, including zeros |
| Stations when sampled | `polls.avg_stations_when_sampled` | Mean `sample_count` where samples > 0 |
| API errors by source | `api_errors_by_source.fleet` / `.google` | HTTP ≥400 counts |
| Stale congestion samples | `samples.stale_congestion` | `station_samples.is_stale = 1` |
| Offline gaps | `polls.fleet_vehicle_offline` | Expected in `fleet_only` while the car sleeps |

## HTTP surface

| Path | Access |
|---|---|
| `/.well-known/appspecific/com.tesla.3p.public-key.pem` | Public (Tesla app requirement) |
| `/auth/login` `/auth/callback` | Tesla OAuth |
| `/health` | `Authorization: Bearer <Worker secret>` |
| `/collect` `POST` | Same admin token. Optional JSON `{ "force_source": "fleet" \| "google" \| "auto" }` |
| `/auth/logout` | Admin token |

`force_source=google` bypasses the hourly cooldown.

## Commands

```sh
npm test
npx wrangler types
npx wrangler d1 migrations apply atx-supercharger --local
npx wrangler d1 migrations apply atx-supercharger --remote
npx wrangler secret put COLLECTOR_ADMIN_TOKEN
npx wrangler secret put GOOGLE_MAPS_API_KEY
npx wrangler deploy
```

`$COLLECTOR_ADMIN_TOKEN` in your shell is not the Worker secret. After `wrangler secret put`, use that same string:

```sh
export COLLECTOR_ADMIN_TOKEN='the-value-you-just-put'
curl -sS https://atx-superchargers.serraosays.com/health \
  -H "Authorization: Bearer $COLLECTOR_ADMIN_TOKEN"
```

If the secret was piped with `echo`, it may contain a trailing newline and never match. Prefer the interactive `wrangler secret put` prompt.

Cron: `*/5 * * * *`.

## Modes

- `fleet_only` — current production default. Asleep/offline/out-of-bbox polls are recorded without Google.
- `auto` — Fleet when the car is online and returns in-bbox Superchargers; otherwise Google if the fallback interval has elapsed.
- `dual` — like auto, plus a Google comparison (same hourly cap) while Fleet succeeds, written to `source_comparisons`.

Commissioning: set `COLLECTOR_MODE=dual` and `GOOGLE_DISCOVERY=true` until Place IDs attach to known stations, then `GOOGLE_DISCOVERY=false` and `COLLECTOR_MODE=auto`.
