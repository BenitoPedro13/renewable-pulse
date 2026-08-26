# TASK-reliability-layer

## 1. Current scenario

Phase 1 (`docs/tasks/TASK-ingest-spine.md`) shipped the ONS → Redpanda → TimescaleDB → API
spine, verified live against real ONS data (366,336 readings, zero duplicates on replay). It
deliberately deferred three things, called out explicitly in `apps/consumer/src/index.ts`:

- Invalid readings (schema-invalid or unknown-zone) are logged and dropped, not routed anywhere
  durable.
- There is no backpressure/burst regression test — Phase 1's proof that the consumer keeps up
  with a real ~366k-row poll was a manual live run, not an automated test.
- There is no way to see DLQ depth, consumer lag, or last-successful-poll-per-source. The
  dashboard's future "pipeline health" panel (`docs/brand.md` §4) needs exactly these three
  numbers, per `docs/architecture.md` §5.

This is Phase 2 of `docs/tasks/TASK-implementation-plan.md` §2.

## 2. Planned changes

1. **`packages/contracts`**: add `dlqEventSchema` (`{ raw, error, source_topic, failed_at }`) —
   the shape every DLQ message takes, regardless of which topic/consumer produced it.
2. **`apps/consumer`**:
   - Extract the per-batch persist logic out of `index.ts`'s `eachBatch` into a testable
     `processBatch()` (new `src/batch.ts`) so tests can drive it directly against real
     testcontainer infra without running the full long-lived consumer loop.
   - `processBatch` now publishes each `InvalidReadingError` to `readings.dlq` (via a connected
     Kafka producer) instead of only logging it — closing invariant 5
     (`CLAUDE.md`: "a dead-letter queue, not a dropped or crashing consumer").
   - `src/dlq-cli.ts`: a minimal CLI (`pnpm --filter consumer dlq -- list|replay`) —
     `list` prints the N most recent DLQ messages, `replay` re-publishes their `raw` payload back
     onto `readings` and trims the replayed range off `readings.dlq` via the admin client's
     `deleteTopicRecords`.
3. **Tests** (`docs/architecture.md` §5, real infra only — `@testcontainers/redpanda` added
   alongside the existing `@testcontainers/postgresql`):
   - DLQ routing: a batch with one malformed event among valid ones lands the valid rows in
     TimescaleDB and the malformed one (unchanged) on `readings.dlq`, without blocking the batch.
   - Backpressure/burst: `processBatch` on a large single batch (~50k events, matching the order
     of magnitude of a real ONS poll) persists all of them and completes within a generous time
     bound — a regression guard on the batched-upsert path Phase 1 fixed by hand, not a
     replacement for the real 366k-row live run already on record in
     `docs/tasks/TASK-ingest-spine.md` §6.
   - (Idempotency is already covered by `persist.spec.ts` from Phase 1 — no change needed.)
4. **Observability** — `GET /pipeline-health` on `apps/api`, backed by:
   - **DLQ depth**: `admin.fetchTopicOffsets("readings.dlq")`, summed `high - low` across
     partitions.
   - **Consumer lag**: `admin.fetchTopicOffsets("readings")` minus `admin.fetchOffsets({ groupId:
     "persist" })`, summed across partitions.
   - **Last-successful-poll-per-source**: `SELECT source, MAX(ingested_at) FROM readings GROUP BY
     source`, right-joined against `contracts`' `sourceSchema.options` so a source with no data
     yet reports `null` instead of being silently omitted — showing a gap as missing data, per
     the project's hard constraint, rather than papering over it. `ingested_at` is stamped once
     per poll cycle in `apps/ingest/main.go`, so its max is exactly "last time this source's poll
     produced at least one persisted reading" — no new heartbeat topic/table needed.

## 3. Why

- DLQ-on-drop (not log-on-drop) is invariant 5 in `CLAUDE.md` — Phase 1 explicitly deferred it
  rather than skipping it silently.
- Deriving last-poll from `ingested_at` instead of adding a heartbeat topic/table avoids a second
  schema to keep in sync across Go/TS for a number the existing data already encodes exactly.
- Extracting `processBatch` is required to test DLQ routing and burst behavior against real infra
  without booting the whole long-running consumer process per test.

## 4. Affected files

- `packages/contracts/src/dlq.ts` (new), `src/index.ts` (export)
- `apps/consumer/src/batch.ts` (new), `src/index.ts` (use it), `src/dlq-cli.ts` (new),
  `package.json` (new `dlq` script, `@testcontainers/redpanda` devDependency)
- `apps/consumer/src/batch.spec.ts` (new — DLQ routing + burst tests)
- `apps/api/src/routes/pipeline-health.ts` (new), `src/lib/kafka-health.ts` (new — pure
  offset-arithmetic, split out per §6 below), `src/index.ts` (register route), `package.json`
  (`@confluentinc/kafka-javascript` dependency for the admin client, `@testcontainers/redpanda`
  devDependency)
- `docs/architecture.md` §5 (mark DLQ/backpressure/observability as built, not just planned)
- `README.md` (status line)

## 5. Verification

- `pnpm --filter consumer test` and `pnpm --filter api test` pass, including the new DLQ-routing
  and burst tests, against real Redpanda + TimescaleDB testcontainers.
- Manual: run the full stack, publish one malformed event by hand alongside a real ONS poll,
  confirm it appears in `readings.dlq` via `pnpm --filter consumer dlq -- list` and that valid
  rows from the same poll still land in TimescaleDB.
- `curl localhost:3001/pipeline-health` returns real, non-fabricated numbers: 0 DLQ depth / 0 lag
  on a freshly-drained system, and a `lastPollBySource` entry for `ONS` matching the actual last
  poll time in the logs.
- `pnpm build`, `pnpm typecheck`, `pnpm lint` clean across the monorepo; `go build ./...`, `go
  vet ./...` clean in `apps/ingest` (unchanged by this phase, but re-checked since nothing here
  should touch it).

## 6. Known issue: the Kafka admin client hangs intermittently under testcontainers

`computeKafkaHealth`'s use of `@confluentinc/kafka-javascript`'s admin client
(`admin.fetchTopicOffsets`/`fetchOffsets`) is **not** exercised end-to-end against a real broker
in the automated suite, unlike everything else in this phase. During development, calling those
methods against a `@testcontainers/redpanda` container reproducibly hung the whole test process
indefinitely on a roughly coin-flip basis — confirmed over ~8 separate repro attempts, isolating
away every plausible cause (fresh vs. reused container, single vs. multiple `Kafka` client
instances in-process, concurrent vs. sequential admin calls, with/without a Postgres
testcontainer alongside it, with/without Fastify) without finding a deterministic trigger. The
hang showed sustained ~99% single-thread CPU the entire time — consistent with a genuinely
blocking native call, which explains why neither the admin client's own `timeout` option nor
Vitest's own test-level timeout could ever preempt it once it started.

What this isn't: a bug in this project's code. `deriveKafkaHealth` (the actual depth/lag
arithmetic) is pure and fully unit-tested (`apps/api/src/lib/kafka-health.spec.ts`) with literal
fixture data. The admin-client plumbing around it was verified correct by hand, repeatedly, via
a standalone Node script run directly (no Vitest, no testcontainers) against a live Redpanda
container — every such run succeeded immediately (tens of milliseconds). And in the real,
non-testcontainer stack (`docker-compose`'s already-running Redpanda + TimescaleDB, which is how
`apps/api` actually runs in dev/prod — it only ever connects to them as a client, never starts
them itself), there is no testcontainers layer to trigger this at all.

**How to apply:** verify `/pipeline-health`'s DLQ depth and consumer lag manually via `curl`
against the real `docker-compose` stack (§5 above) rather than trusting an automated test for
that specific path. If this resurfaces as a real (non-test) production hang, suspect
`@confluentinc/kafka-javascript`'s admin client specifically — check its changelog/issues for a
newer version, or consider moving admin calls to a killable child process/worker so a stuck
native call can't take the whole `apps/api` process down with it.
