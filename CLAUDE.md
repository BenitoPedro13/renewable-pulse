# Workflow Guidelines — Renewable Pulse

> Ported from the `flora` workflow (plan before you touch anything, use official CLIs/
> generators, treat documentation as part of the deliverable), retargeted to this project.

---

## 0. Project context

The design lives in `docs/architecture.md` (system) and `docs/brand.md` (visual identity).
Read `docs/tasks/TASK-implementation-plan.md` for the phased build order before writing any
code — it is the entry point for implementation, not this file.

Renewable Pulse ingests **real, public** renewable-energy generation data (Brazil via ONS,
Norway via ENTSO-E, USA via EIA) through a high-throughput, failure-resistant pipeline, and
serves it through a live dashboard. It is a standalone companion to Flora
(`../flora`, a regenerative-farming console) — sharing Flora's AlignUI visual language and
workflow conventions, but no code.

**Hard constraint:** every reading in this system must trace back to a real API response from
ONS, ENTSO-E, or EIA. No synthetic or simulated data, anywhere, ever — decided explicitly
during planning, not a default that can be quietly relaxed for convenience (e.g. to fill a demo
gap). If a real source is unavailable for something, that gap is shown as missing, not faked.

**Status (unstarted):** specs only — `docs/architecture.md`, `docs/brand.md`,
`docs/tasks/TASK-implementation-plan.md`. No code, no `package.json`, no `go.mod`, no infra.
Phase 1 (`docs/tasks/TASK-implementation-plan.md` §2) is next.

### Stack (see `docs/architecture.md` §6 for rationale)

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Ingestion edge | **Go** — scheduled pollers, normalizes to the canonical event schema |
| Broker | **Redpanda** (Kafka-API-compatible) |
| Storage | **PostgreSQL + TimescaleDB** |
| Consumer / API | **TypeScript** (Node) |
| Web | **Next.js**, AlignUI design system (amber primary — `docs/brand.md` §2) |
| Contracts | **Zod** in `packages/contracts`, consumed by consumer/API/web; `apps/ingest` (Go) hand-mirrors the same shape — a deliberate cross-language seam, not an oversight |

Version numbers are a snapshot, not a pin — verify against each tool's own current docs before
installing.

### How to write in this repo

- **Never invent an API response shape, field name, or provider behavior.** Write
  `[VERIFY: what to check and where]` inline instead. `docs/architecture.md` already carries
  several (ONS dataset endpoints, ENTSO-E document types, EIA v2 request shape, Iceland's data
  source). Resolve each before the code depending on it ships.
- **Be specific to the point of discomfort**: exact endpoint paths, exact field names, exact
  poll intervals. No acceptance criterion may rest on "works" or "fast enough".

### Invariants — never break these without changing the spec first

1. **No synthetic or simulated data, anywhere.** This is the project's entire premise; see
   "Hard constraint" above.
2. **`packages/contracts` is the single source of truth for the event/API shape on the TS
   side.** `apps/ingest`'s Go structs mirror it by hand — whoever changes the schema updates
   both in the same task.
3. **Idempotent writes only.** Every write to TimescaleDB is keyed on
   `(source, zone, asset_id, metric, recorded_at)`; re-processing the same event must never
   duplicate a row.
4. **No colors outside the AlignUI ramps already defined**, plus the one primary-accent swap
   documented in `docs/brand.md` §2 (amber instead of Flora's green). Don't invent new hex
   values for charts or the map — reuse the existing semantic ramps per `docs/brand.md` §2.
5. **A dead-letter queue, not a dropped or crashing consumer**, is how malformed/unknown events
   are handled (`docs/architecture.md` §5).

### Tests

- **Integration tests against real infra** (testcontainers: Redpanda, TimescaleDB) — never mock
  the broker or database.
- **Idempotency is a test, not an assumption**: replay the same poll response twice, assert row
  count is unchanged.
- **DLQ routing is a test**: a malformed event inside a valid batch must land in `readings.dlq`
  without blocking the valid ones.
- **A provider's response shape is tested from a real captured response**, not a hand-built
  mock — matches this project's "real data only" ethos.

---

## 1. Plan before executing — write a task document first

**Rule:** Before editing or creating any code file, write a task document at
`docs/tasks/TASK-<slug>.md` with: Current scenario, Planned changes, Why, Affected files,
Verification (see `docs/tasks/TASK-implementation-plan.md` for the template this project
uses). Keep it in sync if the plan changes mid-task.

## 2. Use CLIs, generators, and SDKs — don't write everything by hand

Check each tool's current docs before scaffolding or adding a dependency, then use its official
CLI/generator (AlignUI's CLI for the design tokens, `pnpm create`/framework generators for
apps, `drizzle-kit generate` if Drizzle is used for the TS-side schema, etc.).

## 3. Update documentation after executing

Before considering a task done, update every doc it affects: this file (if the stack or an
invariant changes), `docs/architecture.md` (if it resolves a `[VERIFY]` or changes scope),
`docs/brand.md` (if a visual `[VERIFY]` resolves), `.env.example` (every env var the code
reads), and `README.md` (status line and quickstart).

## 4. Project conventions

```
apps/
  ingest/     Go — scheduled pollers, normalize, publish to Redpanda
  consumer/   TS — "persist" and "live" consumer groups
  api/        TS — REST + WebSocket
  web/        Next.js — dashboard
packages/
  contracts/  Zod schemas + inferred types
  config/     shared tsconfig, eslint, prettier
infra/        docker-compose — Redpanda, TimescaleDB
docs/         architecture.md, brand.md, tasks/
```

### Commit conventions

- Commit automatically once a task doc's work is complete and verified — don't wait to be asked
  for each one. Not blanket permission for destructive git operations, which still need
  explicit confirmation.
- **Never add a `Co-Authored-By` trailer to commits in this repo.**

---

## TL;DR

Plan (`docs/tasks/TASK-<slug>.md`) → align → build with official generators, real data only,
types from `packages/contracts` → update `docs/architecture.md` / `docs/brand.md` /
`.env.example` / `README.md` → commit (no `Co-Authored-By`) → done. Never broken: no synthetic
data, idempotent writes only, contracts are the single source of truth, no colors outside the
documented AlignUI ramps, malformed events go to the DLQ instead of crashing the consumer.
