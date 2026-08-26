# Architecture — Renewable Pulse

> Status: **spec only, nothing built yet.** This document is the design of record for the
> implementation session that follows `docs/tasks/TASK-implementation-plan.md`.

## 1. Problem statement and scope

Renewable Pulse is a case-study project: a real-time-feeling data platform that ingests
**real, public renewable-energy generation data** for Brazil, plus a comparison set of
near-100%-renewable grids (Norway, Iceland) and the USA, and serves it through a
high-throughput, failure-resistant ingestion pipeline. It exists as a companion to
[Flora](../../flora), a regenerative-farming console, and doubles as an engineering rehearsal
for the IoT/device-ingestion problem Flora's own `docs/architecture.md` §1.4/§11.4 explicitly
identified and deferred (no device protocol was ever chosen there).

**In scope:**
- Polling three free, real public grid-data APIs (ONS Brazil, ENTSO-E, EIA) on a schedule.
- Normalizing their very different shapes into one canonical event schema.
- Publishing every reading as an event into a broker, so downstream consumers see a genuine
  stream rather than a batch import.
- Persisting to a time-series store with idempotent writes.
- A live dashboard: a Brazil deep-dive (plant/subsystem mix, reservoir levels) and a
  country-comparison view (Brazil vs. Norway/Iceland vs. USA renewable share over time).
- Reliability engineering as a first-class, documented concern: idempotency, a dead-letter
  queue, backpressure.

**Out of scope (v1):**
- Any simulated or synthetic data. **Every reading in this system must trace back to a real
  public API response.** This is a hard constraint, not a style preference — the user
  explicitly rejected a simulated-sensor stand-in during planning.
- Physical IoT devices / MQTT ingestion from real hardware. There are no real sensors to
  ingest from yet (mirrors Flora's own current state). The architecture is *shaped* so that a
  real device feed could join the same pipeline later (§7), but nothing here talks to hardware.
- Payment-gated data (ElectricityMaps real-time signals, ~€4,500/yr/signal) and derived-only
  signals (WattTime's marginal-emissions rate) — free raw-generation-mix sources cover the
  story without them.

## 2. Being honest about "real-time"

None of the three source APIs are push/streaming; all are polled. So the "high-throughput,
real-time" character of this project comes from the pipeline's own engineering, not from the
upstream data being sub-second:

- **ONS (Brazil)** publishes generation broken down to individual plants, plant groups, and
  subsystems — so a single poll cycle yields hundreds of individual real readings, not one
  number per country. `[VERIFY: ONS's docs describe some series as "read from origin, updated
  daily" — confirm during implementation whether "hourly" data actually refreshes hourly or is
  hourly-bucketed-but-daily-refreshed. This changes the realistic poll interval.]`
- **ENTSO-E** (used for Norway/Iceland) reports at 15–60 minute resolution depending on series.
- **EIA** (USA) reports hourly.

The legitimate high-throughput/reliability story is: (a) plant-level granularity × three grids
× several dataset types per grid produces genuinely bursty batches of real events per poll
cycle, and (b) the pipeline is built to real streaming standards — partitioned topics,
independent consumer groups, idempotent upserts, a dead-letter queue, backpressure — the exact
same shape a continuous real device feed would need. State this plainly in the README; do not
let the marketing imply sub-second sensor push where the data is actually polled.

## 3. Real data sources

| Source | Coverage | Granularity | Access | Data pulled |
|---|---|---|---|---|
| **ONS Dados Abertos** (`dados.ons.org.br`) | Brazil (SIN grid) | Hourly; per-plant / per-plant-group / per-subsystem | Free, open data, no key | Generation by source (hydro/thermal/solar/wind), reservoir levels (EAR/ENA), subsystem interchange, load, marginal cost (CMO) |
| **ENTSO-E Transparency Platform** | EU bidding zones, incl. Norway | 15/60-min depending on series | Free — email `transparency@entsoe.eu` with "RESTful API access" in the subject, registered address in the body; token issued within ~3 business days | Generation by fuel type per bidding zone, load, cross-border flows |
| **EIA Open Data API** | USA | Hourly | Free, instant self-serve API key at `eia.gov/opendata` | Generation by fuel type, by balancing authority / state |

`[VERIFY: exact ONS dataset endpoint paths and response schemas — the ONS Dados Abertos portal
exposes datasets as CKAN-style resources (res_format=API); confirm the specific resource IDs for
generation-by-source, reservoir levels, and CMO before writing the poller, from
dados.ons.org.br's own dataset pages.]`

`[VERIFY: ENTSO-E's RESTful API returns XML in IEC 62325 format — confirm the exact document
types (A75 for actual generation per type, etc.) against the current Transparency Platform
REST API guide before writing the poller.]`

`[VERIFY: EIA API v2 request shape (facet/frequency parameters) against the current
eia.gov/opendata/documentation.php before writing the poller — the v1→v2 API had breaking
changes historically.]`

Iceland is not in ENTSO-E's coverage (not an EU member / not on the synchronous grid) —
`[VERIFY: whether Iceland's grid operator Landsnet publishes an open data API; if not, the
Iceland comparison point may need to fall back to an annual/static figure cited in the
dashboard rather than a polled series — decide this in the implementation session's first task
doc rather than silently dropping Iceland.]`

## 4. Event pipeline

```
┌─────────────────────────────────────────────┐
│ apps/ingest (Go)                             │
│  - one poller per source (ONS / ENTSO-E/EIA) │
│  - normalizes to the canonical event schema  │
│  - publishes to Redpanda topic "readings"    │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │ Redpanda           │
              │ topic: readings     │
              │ topic: readings.dlq │
              └─────────┬─────────┘
                        │
        ┌───────────────┴───────────────┐
        ▼                                ▼
┌───────────────────┐          ┌────────────────────────┐
│ apps/consumer       │          │ apps/consumer            │
│ group: "persist"    │          │ group: "live"             │
│ idempotent upsert    │          │ WebSocket fan-out to      │
│ → TimescaleDB         │          │ apps/api's live clients    │
└───────────────────┘          └────────────────────────┘
        │ on validation/unknown-asset failure
        ▼
┌───────────────────┐
│ readings.dlq        │
└───────────────────┘
```

- **Canonical event schema** (defined once in `packages/contracts`, mirrored by hand in Go —
  see §6 on the cross-language seam): `{ source, zone, asset_id | null, metric, value, unit,
  recorded_at, ingested_at, schema_version }`. `zone` is a stable code (`BR-SIN`, `NO-NO1`,
  `US-CAISO`, etc.), `asset_id` is null for zone/subsystem-level readings and set for
  plant-level ones.
- **Idempotency key**: `(source, zone, asset_id, metric, recorded_at)` — a poller re-fetching
  the same window must not create duplicate rows. TimescaleDB upsert on this composite key.
- **Dead-letter queue**: any event that fails schema validation, or references a `zone`/`metric`
  outside a maintained allowlist, is published to `readings.dlq` instead of raising — the
  consumer keeps processing the rest of the batch. A DLQ depth alert/replay tool is part of the
  reliability work (§5), not an afterthought.
- **Backpressure**: pollers publish in bounded batches with a channel/queue depth limit in Go;
  if Redpanda or a consumer is behind, the poller blocks rather than unboundedly buffering in
  memory. Consumer groups can scale horizontally (Redpanda partition count sets the ceiling).

## 5. Reliability patterns to build and document

These are the explicit engineering deliverables that justify the "high-throughput ingestion
without failing" framing:

1. **Idempotent consumers** — at-least-once delivery is the default posture for Kafka-style
   brokers; duplicates are expected, not a bug. Verify with a test: replay the same poll
   response twice, assert row count is unchanged.
2. **Dead-letter queue** — poison messages (schema mismatch, unknown zone) never block the
   topic. Verify with a test: publish one malformed event inside a batch of valid ones, assert
   the valid ones land in TimescaleDB and the malformed one lands in `readings.dlq`.
3. **Backpressure** — a burst-publish test (e.g. replay a full day of ONS plant-level data at
   once) should show bounded memory in the poller and steady (not exploding) consumer lag.
4. **Observability** — DLQ depth, consumer lag, and last-successful-poll-per-source are the
   three numbers the dashboard's own "pipeline health" panel shows — this is also a chance to
   demonstrate the system honestly to a visitor, per §2.

## 6. Stack

| Layer | Choice | Why |
|---|---|---|
| Ingestion edge | **Go** | Best concurrency/memory story for the high-throughput case study; deliberate choice to build real Go experience. |
| Broker | **Redpanda** | Kafka-API-compatible, single binary, no JVM/ZooKeeper, one-click Railway template. Chosen over RabbitMQ/Mosquitto because there's no real MQTT device layer yet — Kafka-style partitioning + independent consumer groups is the more relevant pattern here and the one that carries forward once real devices exist. |
| Storage | **TimescaleDB** (Postgres + Timescale extension) | Hypertables + continuous aggregates; stays "just Postgres" so it doesn't introduce an unfamiliar query layer; Railway template available. |
| Consumer / API | **TypeScript** (Node) | Matches the rest of the user's stack; lets `apps/consumer`, `apps/api`, and `apps/web` share Zod contracts, the same pattern Flora uses via `packages/contracts`. |
| Dashboard | **Next.js** | Same framework Flora's `apps/web` uses. |
| Contracts | **Zod** in `packages/contracts`, consumed by `apps/consumer`, `apps/api`, `apps/web` | `apps/ingest` (Go) cannot import Zod — its Go structs are a **hand-maintained mirror** of the same schema, called out explicitly as a deliberate seam, not an oversight. Whoever changes the event schema must update both sides in the same task. |
| Local dev infra | `docker-compose.yml`: Redpanda (+ its console UI), TimescaleDB | Mirrors Flora's `infra/docker-compose.yml` pattern of one compose file per repo. |
| Deployment | Railway, own project | Standalone from Flora's Railway project. |

## 7. How this connects back to Flora

Flora's `docs/architecture.md` (§1.4) states: *"Not real-time... No IoT or device ingestion,"*
and §11.4 leaves an open `[VERIFY: what actually produces these readings — inverter API, Modbus
gateway, manual entry?]` against its deferred `EnergyAsset`/`EnergyReading` tables. Flora has no
broker, no time-series DB, and no streaming infrastructure today — only BullMQ-on-Redis for
background jobs. The canonical-event → broker → idempotent-consumer → time-series-store shape
built here is intentionally the shape Flora's own deferred Energy screen would need once a real
device protocol is chosen. This project does not import any Flora code (separate repo, separate
deploy) — the connection is architectural precedent, not a shared package.

## 8. Visual identity

See `docs/brand.md` for the full spec. Summary: shares Flora's AlignUI design system, neutral
palette, and typography, with its own primary accent (amber, standing for the "pulse"/live-data
identity) so the two projects read as a connected pair without being visually identical.

## 9. Repo layout

```
renewable-pulse/
  apps/
    ingest/       Go — scheduled pollers (ONS/ENTSO-E/EIA), normalize, publish to Redpanda
    consumer/     TS/Node — "persist" and "live" consumer groups off the same topic
    api/          TS — REST for historical queries + WebSocket for the live feed
    web/          Next.js — Brazil deep-dive + country-comparison dashboard
  packages/
    contracts/    Zod schemas for the canonical event + API DTOs
    config/       shared tsconfig/eslint/prettier
  infra/
    docker-compose.yml   Redpanda (+ console), TimescaleDB
  docs/
    architecture.md   (this file)
    brand.md
    tasks/            one TASK-<slug>.md per unit of implementation work
  README.md
```

## 10. Open questions

- Iceland's data source (§3) — resolve in the first implementation task doc.
- Exact Nest vs. Fastify choice for `apps/api` — left to the implementation session.
- Whether `apps/consumer`'s two consumer groups ship as one process with two consumer instances,
  or two separate deployable processes — a Railway service-count/cost tradeoff to decide during
  implementation, not here.
