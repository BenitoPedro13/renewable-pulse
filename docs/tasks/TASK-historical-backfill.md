# TASK-historical-backfill

## 1. Current scenario

Phases 1–3 (`docs/tasks/TASK-ingest-spine.md`, `TASK-reliability-layer.md`,
`TASK-entsoe-eia-pollers.md`) shipped and live-verified three Go pollers in `apps/ingest`, all
funneling through the same publish path into Redpanda's `readings` topic, `apps/consumer`'s
`persist` group, and the `readings` TimescaleDB hypertable. Every poller only ever fetches a
short trailing window from "now":

- **ONS** (`apps/ingest/internal/ons/client.go`) — `FetchCurrentMonth` (`client.go:51-54`) always
  re-fetches the current month's whole CSV from
  `https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/geracao_usina_2_ho/GERACAO_USINA-2_{YYYY}_{MM}.csv`.
- **ENTSO-E** (`apps/ingest/internal/entsoe/client.go`) — a fixed `entsoeLookback = 2 * time.Hour`
  trailing window (`apps/ingest/main.go:144,149-187`), described in-code as "wide enough to
  survive one missed poll cycle," not a historical mechanism.
- **EIA** (`apps/ingest/internal/eia/client.go`) — a fixed `eiaLookback = 5 * 24 * time.Hour`
  trailing window (`main.go:190,195-223`).

`apps/ingest/main.go` has exactly one CLI flag beyond its env-var configuration, `--once` (poll a
single time and exit, `main.go:24-25`). There is no `--backfill`/`--since`/`--from` flag, and a
repo-wide search for "backfill"/"historical" finds nothing in `apps/ingest` — the only related
hit is `docs/tasks/TASK-live-dashboard.md:56`, which mentions "no process was left running" re: an
ONS backfill, implying one was previously run ad hoc and manually, never as a supported mode.

As a result, the `readings` table holds only the data accumulated since each poller went live
(ENTSO-E: 2026-08-27; the others slightly earlier) — on the order of ~500k rows, spanning days,
not years. This blocks any "how has this zone's mix changed over time" analysis, which is the
entire premise of `docs/tasks/TASK-analytics-roadmap.md`.

### What's already there to build on

Critically, all three `Fetch*` functions **already accept an arbitrary date range** — they were
never restricted to "now," just never called with anything else:

- `ons.FetchMonth(ctx, year, month)` (`ons/client.go:25`) — `FetchCurrentMonth` is a thin wrapper
  around this that happens to always pass `time.Now()`.
- `entsoe.FetchActualGeneration(ctx, token, eicArea, start, end)` (`entsoe/client.go:45`) — takes
  an explicit `[start, end)` window.
- `eia.FetchFuelTypeData(ctx, apiKey, start, end)` (`eia/client.go:61-76`) — takes an explicit
  `[start, end)` window and already paginates internally (offset/length, `maxPageLength = 5000`,
  `client.go:37`).

The idempotency guarantee that makes replaying/resuming a backfill safe is already enforced at
the database layer, not just documented as policy: `readings_idempotency_key` is a real unique
index on `(source, zone, COALESCE(asset_id, ''), metric, recorded_at)`
(`apps/consumer/migrations/0001_readings.sql:19-20`), matching `CLAUDE.md`'s invariant #3 exactly.
Re-running any chunk, or re-running the whole backfill from scratch, can never duplicate a row.

### Verified per-provider historical depth (web research, 2026-08-27)

| Provider | Real historical depth | Source |
|---|---|---|
| ONS (Brazil) | Hourly per-plant generation ("Geração por Usina em Base Horária") published back to **2000** — files grouped by year through 2021, by month/year from 2022 on | ONS Dados Abertos portal (`dados.ons.org.br/dataset/geracao-usina-2`) |
| ENTSO-E (Europe/Norway) | Transparency Platform launched **5 January 2015** under Regulation 543/2013 — actual generation per production type (document A75) cannot exist before this | ENTSO-E FAQ / platform documentation |
| EIA (USA) | The hourly balancing-authority feed actually polled today (EIA-930, `/electricity/rto/fuel-type-data/`) only starts **July 2018**. EIA's *separate* monthly/annual plant-level generation-by-fuel data (Form 923/860) goes back to 1970/1949 respectively, but that is a different dataset, not currently polled at all, and out of scope here | EIA Opendata docs, PUDL EIA-930 data source docs |

This means "20 years of history" is a per-provider claim, not a blanket one: Brazil can
genuinely support quarter-century analysis at hourly, per-plant granularity; Europe caps at ~11
years; the US caps at ~8 years *at the grain currently ingested* (a future, separately-scoped
task could add the EIA-923/860 monthly series for deeper-but-coarser US history — noted in
`docs/tasks/TASK-analytics-roadmap.md` as an explicitly separate, undecided extension, not part
of this task).

## 2. Planned changes

### 2.1 Reuse the live pipeline end-to-end, rather than a separate bulk loader

**Decision:** implement backfill as new flags on the existing `apps/ingest` binary, reusing the
full live path — Fetch → Normalize → Publish → Redpanda → `apps/consumer`'s `persist` group →
Postgres — rather than writing a second, direct-to-Postgres bulk-load path.

| | Reuse live pipeline | Direct-to-Postgres one-off loader |
|---|---|---|
| Schema validation | Inherits `packages/contracts` (the single source of truth per `CLAUDE.md` invariant #2) for free | Needs a **third** hand-mirrored copy of the event shape — `apps/ingest` already hand-mirrors the TS contracts once; a bulk loader would be a second, independent mirror with no shared test coverage |
| Idempotency | Same proven unique index (`0001_readings.sql:19-20`) | Would have to correctly reimplement the exact `COALESCE(asset_id, '')` dedup key, untested |
| Bad-data safety net | Unknown zones/metrics land in `readings.dlq` automatically via `apps/consumer/src/batch.ts`'s existing `processBatch` | None, unless separately reimplemented |
| Observability | Free — `/pipeline-health` already reports consumer lag, DLQ depth, and last-poll-per-source | Would need new instrumentation from scratch |
| Volume/backpressure risk | Real: potentially tens of millions of rows moving through a 5000MB Redpanda volume (`.railway/railway.ts:12`) and a single-replica consumer | Bypassed entirely |

The reuse path wins because every one of its risks is an *operational* pacing problem, solvable
with chunking and rate limiting (§2.4–§2.5), whereas the direct-write path's risks are structural
violations of this repo's own stated invariants (a second schema mirror, a second idempotency
implementation). The `Fetch*` functions were evidently left accepting arbitrary windows exactly
so this reuse would be possible without any interface change.

**New flags on `apps/ingest/main.go`** (alongside the existing `--once`, `main.go:24-25`):

- `--backfill string` — one of `"ons" | "entsoe" | "eia"`; empty (default) preserves today's
  live-polling behavior untouched.
- `--backfill-from`, `--backfill-to` — ISO date bounds for the run.
- `--backfill-resume-from` — optional operator-supplied override to skip chunks already known
  complete after a restart (see §2.5).
- `--backfill-rate-limit-delay duration` — inter-chunk sleep, source-specific conservative
  default, operator-tunable.

**Refactor required:** each poller's per-window fetch+normalize+publish logic is currently
inlined directly in its `poll*` function in `main.go` (`pollONS`-equivalent at `main.go:112-141`,
ENTSO-E at `main.go:151-189`, EIA at `main.go:196-224`). Extract each into a small named helper
taking an explicit window, e.g. `fetchAndPublishONSMonth(ctx, pub, year, month, ingestedAt)`,
`fetchAndPublishEntsoeWindow(ctx, pub, token, eicArea, start, end, ingestedAt)`,
`fetchAndPublishEIAWindow(ctx, pub, apiKey, start, end, ingestedAt)` — called by both the existing
live ticker loop and the new backfill loop, so normalize/publish logic is never duplicated.
Matches this codebase's existing small-named-helper style (e.g. `publish.Publisher.Publish`,
`apps/ingest/internal/publish/redpanda.go:45-69`).

**Direction:** iterate **newest → oldest** per provider, starting just before the date range live
polling already covers and walking back toward each provider's earliest real depth (2000 / 2015 /
2018-07). A run that dies partway therefore always leaves a strictly more useful dataset than
before it started, rather than being stuck deep in an old decade with nothing recent yet
backfilled.

**Retry/backoff:** none of the three clients currently retry a failed HTTP call — a live poll
failure today just waits for the next hourly tick (`main.go`'s `POLL_INTERVAL`, default 1h,
`main.go:30,55-64`). A sequential backfill loop making hundreds of consecutive requests cannot
tolerate that; add a small retry-with-backoff (e.g. 3 attempts, exponential) around each
provider's fetch call, scoped narrowly to what the backfill loop needs — do not over-engineer a
generic HTTP retry framework for this.

### 2.2 Per-provider chunking and rate limits

- **ONS** — chunk = 1 calendar month, the natural unit `FetchMonth(ctx, year, month)` already
  takes. It's a static S3 file GET, not a metered API — no documented rate limit found
  (`[VERIFY]`); treat conservatively regardless: strictly sequential, one month at a time, no
  fan-out, with the operator-tunable inter-month delay.
- **ENTSO-E** — loop per configured zone (`entsoe/client.go:31-38`'s five/six Norwegian bidding
  zones), backward from live coverage to 2015-01. Default chunk = 1 week; `[VERIFY]` the exact
  maximum time span the A75 document type accepts per request against ENTSO-E's own API docs
  before running at scale — do not assume 1 week is safe without checking. `[VERIFY]` ENTSO-E's
  fair-use rate limit — not recorded anywhere in this repo's research to date.
- **EIA** — chunk = 30 days (the live poller already proved a 5-day/single-respondent window
  returns 1728 rows, comfortably under the 5000-row page cap per
  `docs/tasks/TASK-entsoe-eia-pollers.md §5.1`; 30 days across all 8 respondents is a reasoned
  widening, still paginated internally by `FetchFuelTypeData`), backward from live coverage to
  2018-07. `[VERIFY]` EIA v2's documented numeric rate limit before running at scale.

None of the three providers' exact rate limits are documented anywhere in this repository today.
Do not invent numbers to fill this gap — ship with a conservative default delay and treat the
first pilot run (§2.3) as the place to observe real-world throttling behavior, tightening or
relaxing the delay from there.

### 2.3 Zone/respondent-enum risk — verify before full-depth runs

`ons/normalize.go` and `eia/normalize.go` build `zone` strings directly from raw source fields
(`"BR-" + row.IDSubsist`, `"US-" + row.Respondent`) with **no enum check on the Go side** — the
only validation is downstream, against the closed `zoneSchema` enum in
`packages/contracts/src/event.ts:14-34`. A row from a subsystem/respondent code not in that list
is not silently dropped — it fails contract validation and lands safely in `readings.dlq` via
`apps/consumer/src/batch.ts`'s existing `processBatch` — but discovering this only after a
multi-day full-depth run would be wasteful.

ENTSO-E carries no equivalent fetch-side risk: its zone list is already closed on the Go side
(`entsoe/client.go:31-38` only ever queries the configured zones), so there's no possibility of
an unexpected zone appearing from ENTSO-E's backfill, only a possible *data-depth* gap (does the
EIC code actually return data that far back).

**Verification step, ONS and EIA only:** before committing to a full-depth run, execute a single
pilot chunk at each provider's earliest boundary (ONS: 2000-01; EIA: 2018-07) through the full
pipeline, then inspect `readings.dlq` with the existing tool
(`pnpm --filter consumer dlq -- list`, `apps/consumer/src/dlq-cli.ts`). If unknown
subsystem/respondent codes surface, extend `zoneSchema`
(`packages/contracts/src/event.ts:14-34`) and its hand-mirrored Go counterpart
(`apps/ingest/internal/event/event.go`) in a small follow-up commit before the full run — same
"closed enum, extend deliberately, never silently widen" posture the schema file's own comment
already states.

### 2.4 ONS-specific fix required before its backfill: DST-naive datetime parsing

`ons/normalize.go:14-19` already carries a `[VERIFY]` about parsing `din_instante` via
`time.ParseInLocation` against `America/Sao_Paulo` with no DST awareness. This has been immaterial
so far because the live poller only ever fetches the *current* month, and Brazil abolished DST in
2019 — no live poll has ever crossed a DST boundary. A 2000–2019 ONS backfill walks through
roughly two decades of DST fall-back/spring-forward transitions, where naive local-time parsing
can produce ambiguous or incorrect UTC timestamps. **Resolve this `[VERIFY]` before running the
ONS backfill specifically** — conveniently, ONS is sequenced last (§2.6), so this is a real
blocking prerequisite, not a parallel nice-to-have.

### 2.5 `generation_hourly` continuous-aggregate refresh gap

`apps/consumer/migrations/0002_generation_hourly.sql`'s continuous aggregate refresh policy
(`add_continuous_aggregate_policy`, `start_offset => 35 days, end_offset => 1 hour,
schedule_interval => 1 hour`) only auto-refreshes the trailing 35 days. Every current
`/generation-*` API route reads `generation_hourly`, not raw `readings` — so backfilled data
older than 35 days will not appear anywhere in the dashboard or a future analytics service without
an explicit refresh.

**Fix:** do not widen `start_offset` to cover decades — that would make the policy's *hourly*
scheduled tick scan the entire history on every run, needlessly expensive for what should stay a
cheap trailing-window refresh. Instead, reuse the manual-refresh pattern already precedented
twice in this repo (`docs/tasks/TASK-railway-deploy.md §5.1` item 8;
`docs/tasks/TASK-live-dashboard.md`'s ENTSO-E cold-start-gap note):

```sql
CALL refresh_continuous_aggregate('generation_hourly', window_start, window_end);
```

Run this once per backfilled chunk-batch (e.g. once per backfilled year, grouping months), scoped
to that batch's exact date range, immediately after confirming consumer lag has returned to zero
for that batch — not as one `NULL, NULL` call over decades of data at the very end, which
TimescaleDB documents as slow and lock-heavy at that scale. Document as an operator runbook step
(a `railway ssh --service timescaledb -- psql ...` command pattern), not a new script file.

### 2.6 Compression policy (new migration)

No compression policy or retention policy exists anywhere in this repository today — confirmed by
a repo-wide grep. Decades of dense hourly data (order-of-magnitude estimate for ONS alone: ~25
years × 8760 hours × 200+ plants ≈ tens of millions of rows) will otherwise accumulate
uncompressed indefinitely.

Add `apps/consumer/migrations/0003_readings_compression.sql`, following this repo's existing
no-framework, filename-ordered migration convention (`apps/consumer/src/db.ts:21-27` applies
`.sql` files in filename order):

```sql
ALTER TABLE readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'source, zone, metric',
  timescaledb.compress_orderby = 'recorded_at DESC'
);

SELECT add_compression_policy('readings', INTERVAL '90 days', if_not_exists => TRUE);
```

- `compress_segmentby = 'source, zone, metric'` deliberately mirrors both the idempotency key's
  non-time columns (`0001_readings.sql`) and `generation_hourly`'s own `GROUP BY`
  (`0002_generation_hourly.sql`), so compression aligns with existing query patterns rather than
  fighting them.
- `compress_after => 90 days` is chosen wider than every live poller's lookback (ENTSO-E: 2h; EIA:
  5 days; ONS: whole-month re-fetch) so that an idempotent replay write from live polling never
  lands on an already-compressed chunk. `[VERIFY]` the exact `INSERT ... ON CONFLICT` behavior
  against compressed hypertable chunks on the specific TimescaleDB/PG17 version in use — behavior
  here has evolved across TimescaleDB releases; the 90-day buffer is a deliberate mitigation
  regardless of the answer, not a substitute for checking it.
- **Sequencing:** enable this policy only after each provider's older ranges are substantially
  backfilled, so bulk backfill writes are never racing a compression job over the same chunks.
- **No retention policy.** Explicitly out of scope — the entire point of this task is to acquire
  decades of history for future analytics; an auto-delete retention policy would directly
  contradict that goal and should not be added as a reflex companion to compression.

### 2.7 Sequencing and operational notes

**Run order: ENTSO-E → EIA → ONS.**

1. **ENTSO-E first** — smallest surface (5–6 zones, no per-plant `asset_id` fanout,
   `entsoe/normalize.go:82` always sets `asset_id: nil`), shallowest depth (~11 years). Cheapest
   possible end-to-end pilot of the entire mechanism — chunking, pacing, resume-by-log, the
   per-chunk `refresh_continuous_aggregate` step, DLQ monitoring — before committing to anything
   larger.
2. **EIA second** — still no `asset_id` fanout, but real pagination load across 8 respondents and
   only ~8 years of depth. Validates the pagination-heavy path at moderate scale.
3. **ONS last** — by far the largest and highest-value dataset (tens of millions of rows across
   25 years and 200+ plants), run only once the mechanism has been proven twice on cheaper
   providers, and only after §2.4's DST fix lands.

**Where backfill runs:** Redpanda has no public listener — `.railway/railway.ts:38-39` advertises
only `redpanda.railway.internal:9092`. A backfill process must run inside Railway's private
network via `railway ssh --service ingest -- ...`, not from a local machine pointed at a public
broker address. `[VERIFY]` the exact `railway ssh`-passes-alternate-args CLI semantics before
relying on it — `docs/tasks/TASK-railway-deploy.md §5.1` already documents multiple Railway CLI
surprises found only by trying them live, so budget for the same here.

**Volume/backpressure:** the `redpanda-volume` is provisioned at 5000MB
(`.railway/railway.ts:12`) — a real capacity constraint if a backfill produces messages faster
than the single-replica `persist` consumer group can drain them. This is the primary justification
for conservative, operator-tunable inter-chunk pacing (`--backfill-rate-limit-delay`) rather than
running each provider's chunks at full speed.

**Resumability:** deliberately *not* a new checkpoint file or a new Postgres-read dependency in
`apps/ingest` (it currently has none — it only talks to Redpanda, via
`apps/ingest/internal/publish/redpanda.go`). Correctness across restarts is already guaranteed by
the existing idempotency index — replaying any already-completed chunk is always safe. Efficiency
is handled by logging one structured line per completed chunk (mirroring the existing
`log.Printf("ingest: ons: poll complete: published=%d skipped=%d")` pattern, `main.go:139`), with
`--backfill-resume-from` set from the last logged chunk boundary on restart. Worst case on
imperfect resume bookkeeping: some redundant re-fetch/re-publish work, never duplication or
corruption.

**Progress observability:** no new subsystem — the same structured per-chunk log lines, plus the
existing `/pipeline-health` endpoint (already reporting DLQ depth, consumer lag, and
last-successful-poll-per-source per `docs/architecture.md §5`). Watch consumer lag live during a
run as the signal for whether pacing needs to slow down.

## 3. Why

Every analysis in `docs/tasks/TASK-analytics-roadmap.md` — diversity trends, capacity-factor
history, anomaly/change-point detection, forecasting, cross-zone clustering, researcher exports —
depends on having real historical rows to compute over. At ~500k rows spanning days, none of that
is meaningful. All three providers already publish the real historical data needed (verified
depths above); the ingest pollers already have the underlying fetch capability
(`FetchMonth`/`FetchActualGeneration`/`FetchFuelTypeData` all already accept arbitrary windows);
what's missing is purely the backfill driver, plus the two DB-side gaps (continuous-aggregate
refresh, compression) that only bite at multi-year scale. This is the lowest-risk, highest-leverage
piece of the whole roadmap to build first, and the honest prerequisite for everything else in it.

## 4. Affected files

- `apps/ingest/main.go` — new `--backfill*` flags, extracted per-window helper functions, backfill
  driver loop (newest→oldest, retry/backoff, resume logging).
- `apps/ingest/internal/ons/client.go` — no interface change (`FetchMonth` already fits); retry/
  backoff wrapper added around its HTTP call.
- `apps/ingest/internal/ons/normalize.go` — DST-aware datetime parsing fix (§2.4), resolving the
  existing `[VERIFY]` at `normalize.go:14-19`.
- `apps/ingest/internal/entsoe/client.go` — no interface change (`FetchActualGeneration` already
  fits); retry/backoff wrapper.
- `apps/ingest/internal/eia/client.go` — no interface change (`FetchFuelTypeData` already fits);
  retry/backoff wrapper.
- `apps/consumer/migrations/0003_readings_compression.sql` (new) — compression policy per §2.6.
- `packages/contracts/src/event.ts` and `apps/ingest/internal/event/event.go` — only touched if
  the §2.3 zone-enum pilot surfaces codes not already in `zoneSchema`.

## 5. Verification

Before this task is considered implementable, resolve the `[VERIFY]` items above:

- ENTSO-E's maximum request time span for document type A75 (§2.2).
- All three providers' actual rate limits, or confirmation that none apply to reasonable
  conservative pacing (§2.2).
- `railway ssh`'s exact CLI semantics for running a one-off backfill process against the `ingest`
  service (§2.7).
- TimescaleDB/PG17's `INSERT ... ON CONFLICT` behavior against compressed chunks (§2.6).

Once implemented, verify per §2.7's sequencing: a pilot chunk + DLQ inspection per provider before
any full-depth run; `/pipeline-health` consumer lag watched live during each run; confirm
`generation_hourly` reflects each backfilled range only after its corresponding manual
`refresh_continuous_aggregate` call, not before.

This task does not include actually executing a full-depth backfill against production — that is
a deliberate, monitored operator action taken after this design is implemented and reviewed, not
an automatic consequence of merging the code.
