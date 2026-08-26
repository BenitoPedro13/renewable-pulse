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
  number per country. **Resolved (2026-08-26):** the `geracao-usina-2` dataset's own metadata
  confirms it refreshes "Diariamente, às 12h e 19h" (daily, at 12:00 and 19:00) — rows are
  hourly-*bucketed* (one row per plant per clock hour) but the file itself is only re-published
  twice a day. A realistic poll interval is therefore on the order of an hour, not minutes.
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

**Resolved (2026-08-26) — ONS generation-by-plant dataset:** `dados.ons.org.br` is CKAN-backed,
but the "API" resource format is **not** a queryable REST endpoint — it's a monthly flat-file
dump hosted on S3, refreshed twice daily per the cadence above. Confirmed via a live fetch:

- Dataset page: `https://dados.ons.org.br/dataset/geracao-usina-2` ("Geração de Usinas em Base
  Horária" — verified hourly generation by plant/plant-set/small-plant-group, 2000–present).
- CKAN metadata API: `https://dados.ons.org.br/api/3/action/package_show?id=geracao-usina-2`
  lists every monthly resource (2022+) in CSV, PARQUET, and XLSX.
- Direct file URL pattern (confirmed live, returns real data as of 2026-08-26):
  `https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/geracao_usina_2_ho/GERACAO_USINA-2_{YYYY}_{MM}.csv`
  — e.g. the August 2026 file is ~53 MB, semicolon-delimited, one row per plant per hour so far
  this month.
- **Confirmed CSV columns** (header row, semicolon-delimited):
  `din_instante;id_subsistema;nom_subsistema;id_estado;nom_estado;cod_modalidadeoperacao;nom_tipousina;nom_tipocombustivel;nom_usina;id_ons;ceg;val_geracao`
  — `din_instante` (timestamp, `YYYY-MM-DD HH:MM:SS`) → `recorded_at`; `id_subsistema`
  (`N`/`NE`/`S`/`SE`/`CO`) → `zone` (prefix `BR-` per our zone-code convention, e.g. `BR-N`);
  `nom_tipousina` (`HIDROELÉTRICA`/`TÉRMICA`/`EOLIELÉTRICA`/`FOTOVOLTAICA`/`NUCLEAR`) →
  `metric`'s source category (`nuclear` kept distinct from `thermal` — see
  `packages/contracts/src/event.ts`); `id_ons` → `asset_id`, **except**: `id_ons` is empty for
  ONS's per-state "Pequenas Usinas" small-plant aggregate rows (e.g. `PQU DFGO HID`), and several
  of those share the same zone+metric+hour (one per state/interconnection pair) — a plain
  `asset_id: null` would collide them under the idempotency key and silently drop all but the
  last (caught empirically: a live poll showed ~16% of rows colliding this way before the fix).
  `nom_usina` is ONS's own name for the aggregate group and is unique within it (verified
  2026-08-26), so `apps/ingest` uses it as `asset_id` whenever `id_ons` is empty, instead of
  `null` — `packages/contracts` doesn't need a schema change for this, `asset_id` was always
  `string | null`, only what gets put in it changed; `val_geracao` → `value`, unit **`MWmed`** —
  confirmed against the dataset's own "Dicionário de Dados" PDF
  (`https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/geracao_usina_2_ho/DicionarioDados_GeracaoPorUsina.pdf`,
  which labels the field `val_geracao: "Geração de Energia na unidade de medida MWmed"` — average
  MW over the hour, not a plain instantaneous MW reading and not MWh. Track this label explicitly
  when normalizing ENTSO-E/EIA units in Phase 3 — don't assume they share it.
  `[VERIFY: the same dictionary PDF does not state a timezone for din_instante (format is just
  "YYYY-MM-DD HH:MM:SS") — resolve whether it's UTC or America/Sao_Paulo (Brazil has used a fixed
  UTC-3 offset, no DST, since 2019) before Phase 1's poller treats recorded_at as authoritative;
  apps/ingest marks this assumption explicitly in code rather than silently picking one.]`
- **Poller design implication:** this is a full-month-file download, not an incremental query —
  the poller must fetch the current month's CSV each cycle and filter to rows newer than its own
  last-seen `recorded_at` high-water mark per zone before publishing, relying on the idempotent
  upsert key to make re-processing safe regardless.

`[VERIFY: reservoir-level (EAR/ENA) and marginal-cost (CMO) dataset slugs — not yet looked up;
resolve when Phase 1 grows beyond generation-by-source, following the same
`dados.ons.org.br/dataset/...` → `package_show` → S3 URL pattern discovered above.]`

**Resolved (2026-08-26), decided in `docs/tasks/TASK-entsoe-eia-pollers.md`:** ENTSO-E's own
Guide/Postman doc pages returned 400/503 when checked live; resolved instead via `entsoe-py`
(`EnergieID/entsoe-py`, a widely-used open-source client that talks to the real production API)
— its actual request-building and XML-parsing code, not a hand-built mock. Base URL
`https://web-api.tp.entsoe.eu/api`, auth via a `securityToken` query param. Actual generation per
type is `documentType=A75` (Actual generation per type), `processType=A16` (Realised),
`in_Domain={EIC area code}` (Norway's five bidding zones: `NO1`→`10YNO-1--------2`,
`NO2`→`10YNO-2--------T`, `NO3`→`10YNO-3--------J`, `NO4`→`10YNO-4--------9`,
`NO5`→`10Y1001A1001A48H`; plus the Netherlands' single bidding zone, `NL`→
`10YNL----------L`, added 2026-08-26 against the same entsoe-py source),
`periodStart`/`periodEnd` as `YYYYMMDDHHmm` UTC. Response is XML
`GL_MarketDocument` (or `Acknowledgement_MarketDocument` + `Reason/text` on error/no-data — the
poller detects this root element rather than trying to parse it as data); each `TimeSeries` has
`MktPSRType/psrType` (fuel-type code), `inBiddingZone_Domain.mRID` (generation) vs.
`outBiddingZone_Domain.mRID` (consumption, e.g. pumped-storage charging — skipped, not
generation), and `Period`/`timeInterval`/`resolution` (`PT60M` in practice for this document
type) /`Point` (`position`+`quantity`); unit is `MAW` (megawatt). `psrType` → canonical `metric`:
`B01`–`B08` (biomass/fossil combustion variants) → `thermal`; `B10`–`B12` (hydro variants) →
`hydro`; `B14` → `nuclear`; `B16` → `solar`; `B18`/`B19` → `wind`; `B20` → `other`. Left
unmapped on purpose (skip+log, not a DLQ case): `B09` geothermal, `B13` marine, `B15`
other-renewable, `B17` waste, `B21`–`B25` (network infrastructure, not generation) — none are
material to Norway's actual hydro/wind-dominated mix; extend the map if a live poll ever shows
one.

**Resolved (2026-08-26), decided in `docs/tasks/TASK-entsoe-eia-pollers.md`:** EIA's own
`documentation.php` returned 503 when checked live; resolved via the v2 API technical docs
excerpted in `RamiKrispin/EIAapi`'s README plus EIA-930 program docs (PUDL's
`data_sources/eia930.html`). Route: `https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/`,
params `api_key`, `frequency=hourly` (UTC), `data[0]=value`, `facets[respondent][]`, `start`/`end`
as `YYYY-MM-DDTHH`, `sort[0][column]=period`, `sort[0][direction]=desc`, `offset`, `length`
(max 5000/page). Respondent scope for v1: `US48` (EIA's own code for the national Lower-48
aggregate) — **not** `CAISO`/`CISO`, deviating from this doc's earlier `US-CAISO` zone example
below, which used an invented respondent code; a single national aggregate is also the more
direct fit for the country-comparison view than one specific state ISO. `fueltype` facet has 16
codes, not the 8 originally assumed here — confirmed via a live poll and EIA's own facet-metadata
endpoint (`docs/tasks/TASK-entsoe-eia-pollers.md` §5.1): `COL`/`NG`/`OIL` → `thermal`, `NUC` →
`nuclear`, `WAT`/`PS` (Pumped Storage) → `hydro`, `SUN`/`SNB` (Solar w/ integrated battery) →
`solar`, `WND`/`WNB` (Wind w/ integrated battery) → `wind`, `OTH`/`BAT`/`OES`/`UES`/`UNK`/`GEO`
(standalone storage, unknown, geothermal) → `other`; all 16 codes are mapped, nothing left for
the DLQ.
Response envelope: `{ response: { data: [ { period, respondent, fueltype, value, ... } ] } }`,
`period` as `YYYY-MM-DDTHH` (UTC hour) → `recorded_at`. Unit is `megawatthours`, stored as `MWh`
— an **hourly energy total, not a power reading**, a real difference from ONS's `MWmed` and
ENTSO-E's `MAW` (both power units). Numerically an hourly MWh total and an hourly-average-MW
figure are the same number, but that equivalence is a Phase 4 dashboard-layer decision to make
deliberately when charts compare across sources, not something ingest silently assumes.

**Still open:** both resolutions above were cross-referenced against real third-party clients of
the live APIs, not a captured response from our own poller — a live verification pass is owed
once the user has both an ENTSO-E token and an EIA key (`docs/tasks/TASK-entsoe-eia-pollers.md`
§5), matching the rigor Phase 1's 366k-row live ONS poll already established.

Iceland is not in ENTSO-E's coverage (not an EU member / not on the synchronous grid).
**Resolved (2026-08-26), decided in `docs/tasks/TASK-ingest-spine.md`:** Landsnet (Iceland's TSO)
shows live power-flow data on its own website (`landsnet.is`), but no public open-data API or
downloadable dataset was found after checking its site and searching for one — the real-time
view appears to be an internal-only feed with no documented external endpoint. **Decision:**
Iceland ships as a **static annual figure** (cited from a public source, e.g. Landsvirkjun/
Orkustofnun's published generation-mix reports) in the country-comparison view rather than a
polled series, clearly labeled as annual/static in the UI so it's never presented as live data.
This is a Phase 4 (dashboard) concern, not a Phase 1 blocker. `[VERIFY: pick the specific cited
source and figure when Phase 4's country-comparison view is built — Orkustofnun (Iceland's
National Energy Authority) publishes annual statistics and is the more likely authoritative
source than Landsnet itself, which is transmission-only.]`

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
  `US-US48`, etc. — see §3's EIA resolution for why `US48` rather than a specific state ISO),
  `asset_id` is null for zone/subsystem-level readings and set for plant-level ones.
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
without failing" framing. All four are built as of Phase 2
(`docs/tasks/TASK-reliability-layer.md`):

1. **Idempotent consumers** — at-least-once delivery is the default posture for Kafka-style
   brokers; duplicates are expected, not a bug. Verified by `persist.spec.ts`'s
   replay-the-same-event-twice test (Phase 1) and live against a full 366k-row ONS poll
   (`docs/tasks/TASK-ingest-spine.md` §6).
2. **Dead-letter queue** — poison messages (schema mismatch, unknown zone) never block the
   topic. `apps/consumer`'s `processBatch` (`src/batch.ts`) publishes each one to `readings.dlq`
   as `{ raw, error, source_topic, failed_at }` (`packages/contracts`' `dlqEventSchema`) instead
   of dropping it; `apps/consumer/src/dlq-cli.ts` (`pnpm --filter consumer dlq -- list|replay`)
   inspects and replays them. Verified by `batch.spec.ts`'s DLQ-routing test against real
   Redpanda + TimescaleDB testcontainers.
3. **Backpressure** — `apps/ingest`'s `publish.Publisher` bounds in-flight produce requests
   (`MAX_IN_FLIGHT`), and the consumer's batched upserts are chunked to stay under Postgres's
   65535-bind-parameter limit regardless of batch size (`persist.ts`'s `MAX_ROWS_PER_STATEMENT`
   — a real bug `batch.spec.ts`'s 50k-row burst test caught: a single unchunked multi-row INSERT
   at that size exceeds the limit). The live 366k-row Phase 1 run remains the reference proof at
   full scale; the burst test is the automated regression guard.
4. **Observability** — `GET /pipeline-health` on `apps/api` reports the three numbers the
   dashboard's own "pipeline health" panel will show: DLQ depth and consumer lag (via the
   Redpanda admin API's `fetchTopicOffsets`/`fetchOffsets`), and last-successful-poll-per-source
   (`MAX(ingested_at)` per source, `null` for a source with no data yet rather than omitted —
   this is also a chance to demonstrate the system honestly to a visitor, per §2). The
   depth/lag arithmetic is unit-tested (`apps/api/src/lib/kafka-health.spec.ts`); the admin
   client's own I/O against a real broker is verified manually rather than in the automated
   suite — see `docs/tasks/TASK-reliability-layer.md` §6 for why.

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

- ~~Iceland's data source (§3)~~ — resolved in `docs/tasks/TASK-ingest-spine.md` (2026-08-26):
  static annual figure, no polled API found.
- ~~Exact Nest vs. Fastify choice for `apps/api`~~ — **resolved: Fastify.** Phase 1 needs one bare
  HTTP endpoint; Phase 4 adds a WebSocket live feed. Fastify's plugin model (`@fastify/websocket`
  alongside plain HTTP routes) covers both without Nest's DI/module ceremony, which buys nothing
  for a single small service in this monorepo — `apps/api` doesn't need Nest's
  controller/provider layering to stay organized at this scope.
- Whether `apps/consumer`'s two consumer groups ship as one process with two consumer instances,
  or two separate deployable processes — a Railway service-count/cost tradeoff to decide during
  implementation, not here. Still open; Phase 1 only needs the "persist" group, so this is a
  Phase 4 decision.
- ~~ENTSO-E/EIA request/response shapes (§3)~~ — resolved in
  `docs/tasks/TASK-entsoe-eia-pollers.md` (2026-08-26): see §3 for the full detail. **Still open:**
  a live verification pass against real captured responses, pending the user obtaining an
  ENTSO-E token and an EIA key (neither existed yet when this phase was built) — not a blocker for
  Phase 4, but should happen before this data is presented as fully verified.
