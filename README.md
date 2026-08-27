# Renewable Pulse

A live instrument panel for how much of the world's electricity already comes from
renewables — starting with Brazil's hydro-heavy grid, compared against Norway and the USA.

Every reading in this system traces back to a real API response from
[ONS](https://dados.ons.org.br) (Brazil), [ENTSO-E](https://transparency.entsoe.eu) (Norway),
or [EIA](https://www.eia.gov/opendata) (USA). No synthetic or simulated data, anywhere — see
`docs/architecture.md` §2 for an honest discussion of what "real-time" means here, given the
upstream sources are polled, not pushed.

## Status

**Ingestion, reliability, the API layer, and the live dashboard are all built and deployed,
running against real data on Railway.**

| Phase | State |
|---|---|
| 1 — ONS spine (Go → Redpanda → TimescaleDB → API) | ✅ Live-verified: 366,336 real plant/hour readings ingested, zero duplicates on replay |
| 2 — Reliability (DLQ, backpressure, pipeline health) | ✅ Live-verified |
| 3 — ENTSO-E (Norway) + EIA (USA) pollers | ✅ EIA live-verified. ENTSO-E implemented and unit-tested; live verification pending an API token |
| 4 — Live dashboard | ✅ Live-verified — Brazil/USA deep-dives, a Brazil/USA plant-map toggle (ANEEL SIGA + EIA-860), per-plant and per-capacity leaderboards, USA regional (7-RTO) generation mix, volatility charts, a cross-chart metric filter, pipeline-health panel, live WebSocket indicator |
| 5 — Railway deployment | ✅ Live-verified — see Deployment below (`docs/tasks/TASK-railway-deploy.md`) |

Nothing here is faked to look more finished than it is: if a source has no verified data, the
dashboard is expected to show it as missing rather than substitute a placeholder.

## What this is

A companion project to Flora (a regenerative-farming console): a real-time-feeling data
platform that ingests real, public renewable-energy generation data through a high-throughput,
failure-resistant pipeline (Go ingestion edge → Redpanda → idempotent TypeScript consumers →
TimescaleDB → a live Next.js dashboard), and doubles as an engineering rehearsal for the
IoT/device-ingestion problem Flora's own architecture has identified and deferred.

## Data sources (all free, no paywall)

- **[ONS Dados Abertos](https://dados.ons.org.br)** — Brazil's grid operator: generation by
  plant/subsystem, reservoir levels, interchange, load, marginal cost.
- **[ENTSO-E Transparency Platform](https://transparency.entsoe.eu)** — EU grids including
  Norway: generation by fuel type, load, cross-border flows.
- **[EIA Open Data API](https://www.eia.gov/opendata)** — USA: hourly generation by fuel type for
  the US48 national aggregate plus 7 individual RTOs/ISOs (CAISO, ERCOT, ISO-NE, MISO, NYISO, PJM,
  SPP); Form 860/860M plant-level registered capacity for the USA plant map/leaderboard.
- **[ANEEL SIGA](https://dados.gov.br)** — Brazil's official plant registry (CEG, coordinates,
  fuel/phase, capacity), used for the plant map's geography, not for live output.

See `docs/architecture.md` §3 for access details and any open `[VERIFY]` items.

## Architecture

```text
apps/ingest (Go)  →  Redpanda  →  apps/consumer "persist" (TS)  →  TimescaleDB  →  apps/api (Fastify)
                          │                                                             │
                          └────────────────────→  apps/api "live" consumer  →  WebSocket clients (apps/web)
```

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Ingestion edge | Go — scheduled pollers, normalizes to a canonical event schema |
| Broker | Redpanda (Kafka-API-compatible) |
| Storage | PostgreSQL + TimescaleDB, hourly continuous aggregate |
| Consumer / API | TypeScript (Node), Fastify REST + WebSocket |
| Web | Next.js, AlignUI design system |
| Contracts | Zod in `packages/contracts`, hand-mirrored by `apps/ingest`'s Go structs |

Reliability is a first-class concern, not an afterthought: idempotent writes keyed on
`(source, zone, asset_id, metric, recorded_at)`, a dead-letter queue for malformed events
(`readings.dlq`), and bounded backpressure on both ingestion and WebSocket fan-out. See
`docs/architecture.md` for the full design and rationale.

## Repo layout

```text
apps/
  ingest/     Go — scheduled pollers, normalize, publish to Redpanda
  consumer/   TS — "persist" consumer group, TimescaleDB migrations
  api/        TS — REST + WebSocket, "live" consumer group
  web/        Next.js — dashboard
packages/
  contracts/  Zod schemas + inferred types (single source of truth on the TS side)
  config/     shared tsconfig, eslint, prettier
infra/        docker-compose — Redpanda, TimescaleDB
docs/         architecture.md, brand.md, tasks/
```

## Quickstart

```sh
cp .env.example .env   # then `set -a; source .env; set +a` or export the vars into your shell

# 1. bring up Redpanda + TimescaleDB
cd infra && docker-compose up -d
docker exec renewable-pulse-redpanda rpk topic create readings readings.dlq

# 2. build the TS workspace
cd .. && pnpm install
pnpm --filter @renewable-pulse/contracts build

# 3. poll ONS once and publish to Redpanda (real network call, real data)
# set ENTSOE_API_TOKEN / EIA_API_KEY in .env to also enable those pollers —
# unset, they're skipped with a log line rather than failing ingest
cd apps/ingest && go run . --once

# 4. consume + persist into TimescaleDB (runs migrations on startup)
cd ../consumer && pnpm dev

# 5. in another shell: serve persisted rows + the live WebSocket over HTTP
cd apps/api && pnpm dev
curl "http://localhost:3001/readings?limit=10"
curl "http://localhost:3001/pipeline-health"

# 6. in another shell: run the dashboard
cd apps/web && pnpm dev   # localhost:3000

# 7. inspect or replay anything that landed in the DLQ
cd ../consumer && pnpm dlq -- list
pnpm dlq -- replay
```

`docker exec renewable-pulse-timescaledb psql -U renewable_pulse -d renewable_pulse -c "SELECT count(*) FROM readings;"`
and Redpanda Console at `http://localhost:8080` are useful for watching the pipeline directly.

## Deployment

Live on Railway (project `renewable-pulse`): **[renewable-pulse.up.railway.app](https://renewable-pulse.up.railway.app)**
(dashboard), API at `api-production-31f3.up.railway.app`. Six services — `ingest`, `consumer`,
`api`, `web`, plus self-hosted `redpanda` and `timescaledb` (Railway has no managed Postgres
variant with the Timescale extension) — each built from this repo's own per-service
Dockerfiles via `.railway/railway.ts` (Railway's config-as-code) + `railway up`. No GitHub App
connection required. Full topology, the platform-specific gotchas hit along the way (registry
reachability, non-root volume permissions, Docker build-context paths), and verification steps
are in `docs/tasks/TASK-railway-deploy.md`.

`apps/web` is **also** mirrored on Vercel — **[renewable-pulse.vercel.app](https://renewable-pulse.vercel.app)**
— for its edge network, auto-deploying on every push to `main`. `apps/api`'s data routes send
long `Cache-Control` headers (§7 of the task doc) since every reading is identical for every
visitor and the upstream sources only refresh hourly.

## Docs

- `docs/architecture.md` — system design: data sources, event pipeline, reliability patterns,
  stack rationale.
- `docs/brand.md` — visual identity: AlignUI design system with an amber primary accent.
- `docs/tasks/` — one task document per unit of implementation work, written before that work's
  code (see `CLAUDE.md`).

## Contributing

This is a personal case-study project; see `CLAUDE.md` for the workflow it follows (plan
before code, real data only, contracts as the single source of truth, idempotent writes,
DLQ over crashes).
