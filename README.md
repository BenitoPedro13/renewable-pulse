# Renewable Pulse

A live instrument panel for how much of the world's electricity already comes from
renewables — starting with Brazil's hydro-heavy grid, compared against a few countries that
are already almost entirely renewable (Norway, Iceland) and the USA.

**Status: Phase 3 (ENTSO-E/EIA pollers) built, live-verification pending.** ONS Brazil
generation-by-plant data flows real, live, end-to-end: `apps/ingest` (Go) → Redpanda →
`apps/consumer` (TS) → TimescaleDB → `apps/api` (Fastify). Verified against a live ONS poll
(2026-08-26): 366,336 real plant/hour readings ingested and persisted with zero duplicates on
replay. Schema-invalid/unknown-zone readings route to `readings.dlq` instead of being dropped
(`pnpm --filter consumer dlq -- list|replay` inspects/replays them), and `GET /pipeline-health`
reports real DLQ depth, consumer lag, and last-successful-poll-per-source. `apps/ingest` now also
has ENTSO-E (Norway, five bidding zones) and EIA (USA, `US48` national aggregate) pollers on the
same canonical schema, each gated on its own credential env var so ONS keeps running without them
— see `docs/tasks/TASK-entsoe-eia-pollers.md`. **Neither credential exists yet** (ENTSO-E needs an
email-registered token, ~3 business days; EIA's is instant self-serve), so those two pollers are
unit-tested against the resolved request/response shapes but not yet run against a live captured
response — that verification pass is the next thing to do once the user has both. Phases 4–5
(dashboard, polish) are next after that — see `docs/tasks/TASK-implementation-plan.md`.

## What this is

A companion project to [Flora](../flora) (a regenerative-farming console): a real-time-feeling
data platform that ingests **real, public** renewable-energy generation data through a
high-throughput, failure-resistant pipeline (Go ingestion edge → Redpanda → idempotent
TypeScript consumers → TimescaleDB → a live Next.js dashboard), and doubles as an engineering
rehearsal for the IoT/device-ingestion problem Flora's own architecture has identified and
deferred.

**Every reading in this system traces back to a real API response.** No simulated sensors, no
synthetic data — see `docs/architecture.md` §2 for an honest discussion of what "real-time"
actually means here, given the upstream sources are polled, not pushed.

## Data sources (all free, no paywall)

- **[ONS Dados Abertos](https://dados.ons.org.br)** — Brazil's grid operator: generation by
  source, reservoir levels, interchange, load, marginal cost. Plant-level granularity.
- **[ENTSO-E Transparency Platform](https://transparency.entsoe.eu)** — EU grids including
  Norway: generation by fuel type, load, cross-border flows.
- **[EIA Open Data API](https://www.eia.gov/opendata)** — USA: generation by fuel type, by
  balancing authority and state.

See `docs/architecture.md` §3 for access details and open `[VERIFY]` items.

## Docs

- `docs/architecture.md` — system design: data sources, event pipeline, reliability patterns,
  stack rationale.
- `docs/brand.md` — visual identity: shares Flora's AlignUI design system with its own amber
  primary accent.
- `docs/tasks/` — one task document per unit of implementation work, written before that work's
  code (see `CLAUDE.md`).

## Stack

Go (ingestion edge) · Redpanda · TimescaleDB · TypeScript/Node (consumers, API) · Next.js
(dashboard) · Zod (contracts) · pnpm + Turborepo. See `docs/architecture.md` §6 for the
rationale behind each choice.

## Quickstart (Phase 1 spine)

```sh
cp .env.example .env   # then `set -a; source .env; set +a` or export the vars into your shell

# 1. bring up Redpanda + TimescaleDB
cd infra && docker-compose up -d
docker exec renewable-pulse-redpanda rpk topic create readings readings.dlq

# 2. build + run the TS workspace
cd .. && pnpm install
pnpm --filter @renewable-pulse/contracts build

# 3. poll ONS once and publish to Redpanda (real network call, real data)
# set ENTSOE_API_TOKEN / EIA_API_KEY in .env to also enable those pollers —
# unset, they're skipped with a log line rather than failing ingest
cd apps/ingest && go run . --once

# 4. consume + persist into TimescaleDB (runs migrations on startup)
cd ../consumer && pnpm dev

# 5. in another shell: serve the persisted rows over HTTP
cd apps/api && pnpm dev
curl "http://localhost:3001/readings?limit=10"
curl "http://localhost:3001/pipeline-health"

# 6. inspect or replay anything that landed in the DLQ
cd ../consumer && pnpm dlq -- list
pnpm dlq -- replay
```

`docker exec renewable-pulse-timescaledb psql -U renewable_pulse -d renewable_pulse -c "SELECT count(*) FROM readings;"`
and Redpanda Console at `http://localhost:8080` are useful for watching the pipeline directly.
