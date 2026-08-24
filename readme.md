# ATX Supercharger collector

Headless Cloudflare Worker that records Tesla Supercharger utilization in western and southwest Austin every five minutes.

Fleet API is preferred while the associated vehicle is online. GraphQL fallback is implemented but disabled until its authentication spike succeeds (`COLLECTOR_MODE=fleet_only`). The collector never calls `wake_up` or `vehicle_data`.

## Data capture

Every cron tick writes a `poll_runs` row, even when the car is asleep and no Supercharger samples are stored. That is how “no demand” is distinguished from “no observation.”

### `poll_runs` — one row per scheduled interval

| Field | Captures |
|---|---|
| `scheduled_at` | Cadence bucket (unique). Source of scheduled vs actual coverage. |
| `started_at` / `completed_at` | Wall clock for the attempt |
| `vehicle_state` | Tesla `online` / `asleep` / `offline` from `GET /vehicles` |
| `source_used` | `fleet` or `graphql` when samples were persisted |
| `fleet_status` / `graphql_status` | HTTP status from each provider |
| `sample_count` | In-bbox Superchargers stored for this interval |
| `latency_ms` | End-to-end collector duration |
| `status` | Outcome (see below) |
| `error` | Safe, VIN-redacted error string |

Statuses:

- `success` / `partial_success` — charger observations stored
- `fleet_vehicle_offline` — car asleep/offline; no Fleet nearby call; GraphQL not enabled
- `fleet_out_of_region` — Fleet returned sites, none in the study bbox
- `fleet_error` / `graphql_error` / `graphql_auth_failure` / `rate_limited` / `not_connected` / `no_data` — failed collection

### `station_samples` — one row per station per successful poll

| Field | Captures |
|---|---|
| `station_id` | Canonical UUID |
| `station_name` | Display name at sample time |
| `source_station_id` | Tesla Fleet or GraphQL site ID at sample time |
| `source` | `fleet` or `graphql` |
| `available_stalls` / `total_stalls` / `occupied_stalls` / `utilization_pct` | Congestion |
| `site_closed` | Tesla site closure flag |
| `congestion_sync_at` / `congestion_age_seconds` / `is_stale` | Tesla feed freshness (stale if age > `STALE_THRESHOLD_SECONDS`, default 15 minutes) |
| `max_power_kw` / `hardware_generation` | Power and inferred V2/V3/V4 when Tesla sends enough signal |
| `amenities` / `billing_info` | Site character; generation is often `unknown` on Fleet-only payloads |

Samples outside the configured bounding box are discarded. Destination chargers are not stored as samples.

### `stations` — canonical site list

UUID plus `fleet_id`, `graphql_id`, `name`, coordinates, latest stall count, power, hardware generation, and amenities. Matching is Tesla ID first, then coordinates + name. Name is never the permanent key.

### `raw_responses`

Sanitized provider JSON for debugging (VIN/tokens stripped), pruned after `RAW_RETENTION_DAYS`.

## Collection health

`GET /health` (admin token) returns rolling metrics. Default window is 24 hours; pass `?hours=48` up to 168.

```text
coverage_pct = successful_polls / scheduled_polls × 100
```

`successful_polls` are intervals with `status` `success` or `partial_success` (charger data stored). `scheduled_polls` is the number of cadence buckets in the window (288 at a 5-minute interval over 24 hours). Target after GraphQL fallback is enabled: **>95%**.

`coverage_elapsed_pct` uses buckets since the first poll in the window, so a collector that just started is not scored against a full day.

| Metric | JSON path | Meaning |
|---|---|---|
| Scheduled polls | `coverage.scheduled_polls` | Expected cron buckets in the window |
| Successful polls | `coverage.successful_polls` | Intervals that stored Supercharger samples |
| Coverage % | `coverage.coverage_pct` | Successful / scheduled |
| Invocations | `coverage.invocations` | `poll_runs` rows actually written |
| Fleet polls | `polls.fleet` | Intervals persisted from Fleet |
| GraphQL polls | `polls.graphql` | Intervals persisted from GraphQL |
| Failed polls | `polls.failed` | API/auth/rate-limit/no-data errors |
| Average latency | `polls.avg_latency_ms` | Mean `poll_runs.latency_ms` |
| Stations per poll | `polls.avg_stations_per_poll` | Mean `sample_count`, including zeros |
| Stations when sampled | `polls.avg_stations_when_sampled` | Mean `sample_count` where samples > 0 |
| API errors by source | `api_errors_by_source.fleet` / `.graphql` | HTTP ≥400 counts |
| Stale congestion samples | `samples.stale_congestion` | `station_samples.is_stale = 1` |
| Offline gaps | `polls.fleet_vehicle_offline` | Expected in `fleet_only` while the car sleeps |

In `fleet_only`, `coverage_pct` will stay well below 95% whenever the vehicle is asleep. That is a missed observation, not a collector crash. Invocation coverage (`coverage.invocation_pct`) is the check that cron is actually firing.

## HTTP surface

| Path | Access |
|---|---|
| `/.well-known/appspecific/com.tesla.3p.public-key.pem` | Public (Tesla app requirement) |
| `/auth/login` `/auth/callback` | Tesla OAuth |
| `/health` | `Authorization: Bearer $COLLECTOR_ADMIN_TOKEN` |
| `/collect` `POST` | Same admin token. Optional JSON `{ "force_source": "fleet" \| "graphql" \| "auto" }` |
| `/auth/logout` | Admin token |

## Commands

```sh
npm test
npx wrangler types
npx wrangler d1 migrations apply atx-supercharger --local
npx wrangler d1 migrations apply atx-supercharger --remote
npx wrangler secret put COLLECTOR_ADMIN_TOKEN
npx wrangler deploy
```

Cron: `*/5 * * * *`.

## Modes

- `fleet_only` — production default. Asleep/offline/out-of-bbox polls are recorded without GraphQL.
- `auto` — Fleet when the car is online and returns in-bbox Superchargers; otherwise GraphQL.
- `dual` — like auto, plus a GraphQL comparison every 30 minutes while online.
