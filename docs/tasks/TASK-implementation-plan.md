# TASK-implementation-plan

## 1. Current scenario

This repo (`renewable-pulse`) currently contains only specs: `README.md`,
`docs/architecture.md`, `docs/brand.md`, and this document. **No code, no `package.json`, no
`go.mod`, no infra exists yet.** This document is the entry point for the session that builds
the thing — read `docs/architecture.md` and `docs/brand.md` in full before writing any code;
this document does not repeat their content, only sequences the work.

The project: a real-time-feeling data platform ingesting **real, public** renewable-energy
generation data (Brazil via ONS, Norway via ENTSO-E, USA via EIA — Iceland's source is an open
question, see `docs/architecture.md` §3/§10) through a Go ingestion edge, a Redpanda broker, a
TypeScript consumer/API layer, TimescaleDB storage, and a Next.js dashboard. It is a standalone
companion to a separate project, Flora (`../flora`), and intentionally shares Flora's AlignUI
visual language (`docs/brand.md`) and its task-doc-first workflow convention (§5 below) without
sharing any code.

**Hard constraint, not a style choice:** every reading that ever reaches the database must
trace back to a real API response from ONS, ENTSO-E, or EIA. No synthetic/simulated data, ever,
anywhere in this system — this was explicitly decided against during planning.

## 2. Planned changes — phased build order

Each phase below should become its **own** `docs/tasks/TASK-<slug>.md` (see §5) written before
that phase's code — this document sets direction, it does not replace the per-phase task doc.

### Phase 1 — spine: contracts + one real source end-to-end

Goal: prove the whole pipeline shape with the smallest real slice before adding breadth.

1. Scaffold the monorepo: pnpm workspaces + Turborepo (`pnpm-workspace.yaml`, `turbo.json`),
   mirroring Flora's root `package.json` script conventions (`dev`/`build`/`lint`/`typecheck`/
   `test` as `turbo run <task>`). Use each tool's own generator/CLI where one exists — Flora's
   `CLAUDE.md` §2.0 rule ("check current docs before scaffolding, use the official CLI, don't
   hand-author what a generator produces") applies here too.
2. `packages/contracts` — Zod schema for the canonical event (`docs/architecture.md` §4):
   `{ source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version }`.
   This is the single source of truth for the shape on the TS side.
3. `packages/config` — shared tsconfig/eslint/prettier, mirroring Flora's `packages/config`
   structure (`base`/`nextjs`/`nestjs`/`library` variants as needed).
4. `apps/ingest` (Go) — **one** poller: ONS Brazil generation-by-source. Resolve the
   `[VERIFY]`s in `docs/architecture.md` §3 against ONS's live dataset pages before writing the
   HTTP client. Normalize each reading to the canonical event shape (hand-written Go struct
   mirroring the Zod schema — this cross-language duplication is a deliberate, documented seam,
   not an oversight, per `docs/architecture.md` §6). Publish to a Redpanda topic named
   `readings`.
5. `infra/docker-compose.yml` — Redpanda (+ its console UI) and TimescaleDB, for local dev.
6. `apps/consumer` (TS) — one consumer group ("persist") that reads `readings` and does an
   idempotent upsert into a TimescaleDB hypertable keyed on
   `(source, zone, asset_id, metric, recorded_at)`.
7. `apps/api` (TS) — one bare endpoint returning raw rows from TimescaleDB, so the spine is
   observably working end to end without needing the dashboard yet.

**Verification for Phase 1:**
- `docker-compose up` brings up Redpanda + TimescaleDB cleanly.
- Running `apps/ingest` produces real, non-empty events in the Redpanda `readings` topic
  (visible via Redpanda's console UI) sourced from an actual ONS API response — not a fixture.
- Rows land in TimescaleDB with the composite key populated correctly.
- The bare API endpoint returns those rows over HTTP.
- Re-running the same poll window twice does not duplicate rows (idempotency, tested directly —
  don't defer this check to Phase 2; verifying it early is cheap and catches key-shape mistakes
  before more code is built on top).

### Phase 2 — reliability layer

1. `readings.dlq` topic; the consumer routes schema-invalid or unknown-zone events there instead
   of failing the batch.
2. A minimal replay/inspection tool for the DLQ (even a CLI script is fine for v1).
3. Tests per `docs/architecture.md` §5: idempotency (replay-twice), DLQ routing (malformed event
   inside a valid batch), and a backpressure/burst test (publish a large batch at once, assert
   bounded memory in the poller and non-exploding consumer lag).
4. Basic observability: expose DLQ depth, consumer lag, and last-successful-poll-per-source —
   these three numbers are also what the dashboard's "pipeline health" panel will show later
   (`docs/brand.md` §4), so define them once, here, in a form both a script and the future API
   endpoint can read.

### Phase 3 — add ENTSO-E and EIA pollers

1. Resolve the Iceland open question (`docs/architecture.md` §3/§10) before or at the start of
   this phase — decide and record the decision in this phase's task doc, don't leave it silent.
2. Add `apps/ingest` pollers for ENTSO-E (Norway) and EIA (USA), same canonical schema, same
   publish path as Phase 1's ONS poller.
3. This is where the "comparison" story becomes real — confirm all three sources' `zone` codes
   and units are normalized consistently (e.g. MW vs. MWh, instantaneous vs. period totals)
   before they ever share a chart.

### Phase 4 — live dashboard

1. Second `apps/consumer` group ("live") — WebSocket fan-out of new events to connected
   dashboard clients, independent of the "persist" group (`docs/architecture.md` §4 diagram).
2. `apps/api` grows: historical query endpoints backed by TimescaleDB continuous aggregates, and
   a WebSocket endpoint for the live feed.
3. `apps/web` (Next.js): the Brazil deep-dive view and the country-comparison view
   (`docs/brand.md` §4), applying the AlignUI token override from `docs/brand.md` §2 (amber
   primary) via AlignUI's own CLI, then the pipeline-health panel and the live-pulse indicator.

### Phase 5 — case-study polish

1. `README.md` gets the final honest-framing pass (`docs/architecture.md` §2) — what's really
   real-time vs. where the engineering is built ahead of the current data's actual cadence.
2. Architecture diagram (can reuse/adapt the ASCII diagram in `docs/architecture.md` §4).
3. A short Brazil-focused narrative page or section, since that's the primary story
   (`docs/architecture.md` §1).

## 3. Why

Sequencing this way (one real source end-to-end before breadth, reliability before more
sources, dashboard last) means every phase produces something that can be run and looked at,
and catches integration mistakes (event schema, idempotency key shape, unit normalization)
while only one source's data is in play instead of three at once.

## 4. Affected files

Nothing exists yet — Phase 1 creates the entire initial repo structure per
`docs/architecture.md` §9. Each subsequent phase's own task doc should list its affected files
concretely once that phase starts (per §5 below), rather than this document guessing paths for
code that doesn't exist yet.

## 5. Workflow conventions for this repo (recommended, carried over from Flora)

The user's other projects (Flora, and per their own conventions on other repos) follow a
plan-before-code, document-as-you-go workflow. Recommended for this repo too, adjust if the
user says otherwise once implementation starts:

- **Before writing any code for a phase**, write `docs/tasks/TASK-<slug>.md` for that phase
  specifically (e.g. `TASK-ingest-spine.md` for Phase 1), with the same five sections this
  document uses (Current scenario / Planned changes / Why / Affected files / Verification).
- **Never invent an API response shape, field name, or provider behavior.** Write
  `[VERIFY: what to check and where]` inline instead, and resolve it against the provider's
  current docs (or a real captured response) before the code depending on it ships. This
  document and `docs/architecture.md` already carry several — resolve them as each phase
  reaches that part of the system, not all up front.
- **Update `docs/architecture.md` and `docs/brand.md`** whenever a phase resolves a `[VERIFY]`,
  changes scope, or makes a decision this spec assumed differently (e.g. the Iceland question).
- **Commit conventions**: do not add a `Co-Authored-By` trailer to commits in this repo (matches
  the convention already in place on the user's other projects).
- **Testing**: prefer integration tests against real infra (testcontainers for Redpanda/
  TimescaleDB) over mocking the broker or database, matching Flora's own convention and this
  project's "real data only" ethos — a test suite full of mocks would be an odd fit for a
  project whose entire point is not faking things.

## 6. Verification (overall, across all phases)

The project is "done" for v1 when: `docker-compose up` + `apps/ingest` running produces real
ONS/ENTSO-E/EIA events flowing through Redpanda into TimescaleDB with no duplicates; a deliberately
malformed event is provably routed to the DLQ instead of blocking the topic; and `apps/web`
shows a live-updating Brazil view and a three-country comparison view, sourced entirely from
real data, with the pipeline-health panel visibly reporting real DLQ/lag/last-poll numbers.
