# ATX Supercharger collector

Headless Cloudflare Worker that records Tesla Supercharger utilization in western and southwest Austin every five minutes.

Fleet API is the preferred source while the associated vehicle is online. GraphQL fallback is implemented but disabled until its authentication spike succeeds (`COLLECTOR_MODE=fleet_only`).

The collector never calls `wake_up` or `vehicle_data`.

## What it stores

D1 tables:

- `stations` — canonical sites, reconciled across Fleet and GraphQL IDs
- `poll_runs` — one row per five-minute cadence bucket
- `station_samples` — in-bbox Supercharger observations
- `raw_responses` — sanitized payloads, pruned after `RAW_RETENTION_DAYS`
- `source_comparisons` — Fleet vs GraphQL stall diffs during `dual` mode

Samples outside the configured bounding box are discarded.

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
