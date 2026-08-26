# TASK-ingest-spine

## 1. Current scenario

The repo has specs only (`README.md`, `docs/architecture.md`, `docs/brand.md`,
`docs/tasks/TASK-implementation-plan.md`) and no code, no `package.json`, no `go.mod`, no infra.
This is Phase 1 from `TASK-implementation-plan.md` §2: prove the whole pipeline shape
(ingest → broker → consumer → storage → API) with one real source end-to-end before adding
breadth.

Two `[VERIFY]`s that blocked writing the ONS poller are now resolved in `docs/architecture.md`
§3 (see that doc for the full detail, summarized here):

- ONS's `geracao-usina-2` dataset is **not** a queryable REST API — it's a monthly CSV/Parquet/
  XLSX file dump on S3, refreshed twice daily (12:00 and 19:00), semicolon-delimited, with
  confirmed columns `din_instante;id_subsistema;nom_subsistema;id_estado;nom_estado;` `cod_modalidadeoperacao;nom_tipousina;nom_tipocombustivel;nom_usina;id_ons;ceg;val_geracao`.
  Live URL pattern:
  `https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/geracao_usina_2_ho/GERACAO_USINA-2_{YYYY}_{MM}.csv`.
- Iceland has no discoverable open data API (Landsnet's real-time view has no public endpoint) —
  decided: static annual figure in the dashboard later (Phase 4), not a Phase 1 concern.
- Nest vs. Fastify for `apps/api`: resolved to **Fastify** (architecture.md §10) — lighter for a
  single small REST+WebSocket service, no DI ceremony needed at this scope.

## 2. Planned changes

Scaffold the full repo structure from `docs/architecture.md` §9 and build the Phase 1 spine
(`TASK-implementation-plan.md` §2, Phase 1, steps 1–7):

1. **Monorepo scaffold** — `pnpm-workspace.yaml`, root `package.json` (turbo scripts: `dev`,
   `build`, `lint`, `typecheck`, `test`), `turbo.json`. Use `pnpm create turbo@latest` /
   `pnpm init` as the base, then hand-adjust to match `docs/architecture.md` §9's layout rather
   than accepting the generator's default app scaffolding.
2. **`packages/contracts`** — Zod schema for the canonical event:
   `{ source, zone, asset_id: string | null, metric, value, unit, recorded_at, ingested_at, schema_version }`.
   `source` starts as a literal `"ONS"` (extend to a union once Phase 3 adds ENTSO-E/EIA).
   `zone` starts constrained to the five ONS subsystem codes (`BR-N`, `BR-NE`, `BR-S`, `BR-SE`,
   `BR-CO`) via a Zod enum, extended later. `metric` covers the five `nom_tipousina` values
   actually observed in a live poll, normalized to English source names (`hydro`, `thermal`,
   `wind`, `solar`, `nuclear` — nuclear kept distinct from thermal rather than folded in).
3. **`packages/config`** — shared `tsconfig`/`eslint`/`prettier`, `base` variant only for now
   (no Next.js/Nest variant needed until Phase 4's `apps/web`).
4. **`apps/ingest`** (Go, via `go mod init`) — one poller:
   - Fetch the current month's ONS CSV from the confirmed S3 URL pattern.
   - Parse semicolon-delimited CSV (Go stdlib `encoding/csv` with `Comma = ';'`).
   - Normalize each row to the canonical event: `id_subsistema` → `zone` (prefixed `BR-`),
     `nom_tipousina` → `metric` (mapped hydro/thermal/wind/solar/nuclear), `id_ons` → `asset_id`,
     falling back to `nom_usina` (not `null`) when `id_ons` is empty — ONS's per-state small-plant
     aggregate rows share a zone+metric+hour across states and need `nom_usina` to stay distinct
     under the idempotency key (architecture.md §3 has the full story, found empirically during
     this task), `val_geracao` → `value`, unit
     `"MWmed"` (confirmed against ONS's own data dictionary — architecture.md §3), `din_instante`
     → `recorded_at` (timezone unresolved, see architecture.md §3's `[VERIFY]` — treated as
     `America/Sao_Paulo` (UTC-3, fixed, no DST since 2019) for now, called out explicitly in code
     rather than assumed silently), poll time → `ingested_at`, `schema_version: 1`.
   - Track a per-zone high-water mark (`recorded_at` of the last published row) in memory for
     Phase 1 (persisted state is a Phase 2 reliability concern) so re-polling the same file
     doesn't republish everything — but idempotent upsert (step 6) is the actual safety net.
   - Publish to Redpanda topic `readings` in bounded batches (a channel with a depth limit),
     per `docs/architecture.md` §4's backpressure note.
   - Hand-written Go struct mirroring the Zod schema exactly (documented seam, not duplication
     by accident).
5. **`infra/docker-compose.yml`** — Redpanda (+ Redpanda Console) and TimescaleDB, matching
   Flora's one-compose-file-per-repo convention.
6. **`apps/consumer`** (TS/Node) — one consumer group (`"persist"`) reading `readings`, validating
   against the Zod contract, and upserting into a TimescaleDB hypertable on conflict target
   `(source, zone, asset_id, metric, recorded_at)`. Schema migration for the hypertable lives
   here (plain SQL, run via a small migration script — no ORM needed for one table yet).
7. **`apps/api`** (TS, Fastify) — one route, `GET /readings`, returning raw rows from
   TimescaleDB (most recent N, or a `?since=` query param) as JSON validated against the
   contracts' response DTO.

## 3. Why

Per `TASK-implementation-plan.md` §3: proving one real source end-to-end first catches event
schema, idempotency key shape, and unit-normalization mistakes while only ONS is in play, before
Phase 3 adds ENTSO-E and EIA on top of a shape that's already been exercised for real.

## 4. Affected files

New (everything — nothing exists yet):

```
pnpm-workspace.yaml
package.json
turbo.json
packages/contracts/{package.json,tsconfig.json,src/event.ts,src/index.ts}
packages/config/{package.json,base/{tsconfig.json,eslint.config.js,prettier.config.js}}
apps/ingest/{go.mod,go.sum,main.go,internal/ons/{client.go,parse.go,normalize.go},internal/event/event.go,internal/publish/redpanda.go}
apps/consumer/{package.json,tsconfig.json,src/index.ts,src/persist.ts,src/db.ts,migrations/0001_readings.sql}
apps/api/{package.json,tsconfig.json,src/index.ts,src/routes/readings.ts}
infra/docker-compose.yml
.env.example
```

Modified:

```
docs/architecture.md   (already updated — VERIFYs resolved, this task doc references them)
README.md              (quickstart section once the spine runs)
```

## 5. Verification

Matches `TASK-implementation-plan.md` §2 Phase 1 verification, checked in order:

1. `docker-compose up` in `infra/` brings up Redpanda + Redpanda Console + TimescaleDB cleanly.
2. Running `apps/ingest` fetches the real current-month ONS CSV (not a fixture) and produces
   non-empty, correctly-shaped events in the `readings` topic, visible in Redpanda Console.
3. `apps/consumer` upserts those rows into TimescaleDB; row count matches distinct
   `(source, zone, asset_id, metric, recorded_at)` tuples in the polled data.
4. **Idempotency check**: run `apps/ingest` twice against the same ONS file (or replay the same
   captured batch into the topic twice); row count in TimescaleDB is unchanged after the second
   run.
5. `GET /readings` on `apps/api` returns those rows over HTTP as valid JSON matching the
   contracts DTO.
6. `pnpm turbo run lint typecheck` passes across the TS workspace; `go vet ./...` and
   `go build ./...` pass for `apps/ingest`.

## 6. Verification results (2026-08-26)

All six checks above passed against real infra and a real live ONS poll — no fixtures, no
synthetic data:

1. `docker-compose up` in `infra/` brings up Redpanda + Redpanda Console + TimescaleDB cleanly;
   confirmed via `docker ps` (all three containers healthy) and a manual `CREATE EXTENSION
   timescaledb` check.
2. `apps/ingest --once` fetched the live August 2026 ONS file
   (`GERACAO_USINA-2_2026_08.csv`, ~53 MB at poll time) and published **366,336** real events to
   the `readings` topic (48,960 rows skipped: the trailing hour's not-yet-verified empty
   `val_geracao` values, an expected real-data characteristic, not a bug).
3. `apps/consumer` persisted all 366,336 published events into TimescaleDB as exactly 366,336
   rows — full 1:1 correspondence, zero collisions.
4. **Idempotency, proven at full scale**: ran `apps/ingest --once` a second time against the
   live file (366,336 more events, 732,672 total across both runs) and let `apps/consumer`
   process the combined backlog. Final row count: still exactly **366,336**. Re-polling the same
   real month's data twice produced zero duplicate rows.
5. `GET /readings` (Fastify, `apps/api`) returned real persisted rows as valid JSON over HTTP,
   confirmed with `limit` and `since` query params against live data.
6. `pnpm turbo run typecheck lint build test` passes clean across all 4 workspace packages (20
   tests, all against real infra — testcontainers Postgres for `apps/consumer` and `apps/api`,
   no mocked DB). `go vet ./...`, `go build ./...`, `gofmt -l .`, and `go test ./...` all pass for
   `apps/ingest`.

**Two real bugs found and fixed during verification, not before it** — this is why running the
real pipeline end-to-end mattered more than trusting the design on paper:

- **Consumer throughput.** The original `eachMessage`-based consumer (one `INSERT` per Kafka
  message) processed ~25–40 msg/s — at that rate the real 366k-row backlog would take 2–4 hours,
  which doesn't hold up against architecture.md §2's "bursty batches of real events per poll
  cycle" framing. Rewrote to `eachBatch` + a single multi-row `ON CONFLICT` upsert per batch
  (`apps/consumer/src/persist.ts`'s `persistReadings`, batch size 5000 via
  `js.consumer.max.batch.size`). Confirmed live: the same 366k-row backlog now drains in well
  under a minute.
- **Idempotency-key collision on ONS's own aggregate rows.** A live poll showed ~16% of rows
  losing their idempotency race: ONS's per-state "Pequenas Usinas" small-plant aggregate rows
  (e.g. `PQU DFGO HID`, `PQU MGGO HID`) share an empty `id_ons`, and several of them share the
  same zone+metric+hour too (one per state/interconnection pair) — a plain `asset_id: null`
  collided them under the composite key and silently kept only the last one written. Fixed by
  falling back to `nom_usina` (ONS's own name for the aggregate group, confirmed unique within
  it) as `asset_id` instead of `null` whenever `id_ons` is empty (`apps/ingest/internal/ons/normalize.go`).
  Locked in with `apps/ingest/internal/ons/normalize_test.go`. `docs/architecture.md` §3 updated
  to match — this was a schema-shape correction, not a new field.
