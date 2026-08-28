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
  takes. It's a static S3 file GET, not a metered API — no documented rate limit found. Treat
  conservatively regardless: strictly sequential, one month at a time, no fan-out, with the
  operator-tunable inter-month delay (default 2s, `onsDefaultBackfillDelay`).
- **ENTSO-E** — loop per configured zone (`entsoe/client.go:31-38`'s six zones), backward from
  live coverage to 2015-01. **Resolved (web research, 2026-08-27):** most ENTSO-E Transparency
  Platform endpoints, A75 included, cap `periodStart`/`periodEnd` at a maximum one-year span per
  request. Chunk width was widened from the originally-planned 1 week to **30 days**
  (`entsoeBackfillChunk`) — still a wide safety margin under the 1-year cap, and a ~4x reduction
  in request count over the 11-year Europe run. **Resolved:** the platform enforces a **400
  requests/minute per API token** cap; sustained client-side throttling well under that (roughly
  6–7 req/s average) is the documented fair-use expectation. Default inter-chunk delay is 1s
  (`entsoeDefaultBackfillDelay`), comfortably under both figures — six zones × ~11 years of
  30-day chunks is under 900 total requests.
- **EIA** — chunk = 30 days (the live poller already proved a 5-day/single-respondent window
  returns 1728 rows, comfortably under the 5000-row page cap per
  `docs/tasks/TASK-entsoe-eia-pollers.md §5.1`; 30 days across all 8 respondents is a reasoned
  widening, still paginated internally by `FetchFuelTypeData`), backward from live coverage to
  2018-07. **Unresolved:** no documented numeric rate limit was found for EIA v2 in this research
  pass (EIA's own `documentation.php` and `terms-of-service.php` don't state one). Default
  inter-chunk delay is 2s (`eiaDefaultBackfillDelay`) as a conservative placeholder — watch
  `/pipeline-health` and EIA response codes during the pilot run (§2.3) for throttling signals
  before scaling up.

Rate-limit delays are operator-tunable via `--backfill-rate-limit-delay`, overriding the
per-provider defaults above (`main.go`'s `onsDefaultBackfillDelay` / `entsoeDefaultBackfillDelay`
/ `eiaDefaultBackfillDelay`). Do not invent numbers to fill the remaining EIA gap — ship with the
conservative default and treat the first pilot run (§2.3) as the place to observe real-world
throttling behavior, tightening or relaxing the delay from there.

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

**Implemented (2026-08-27):** `time.ParseInLocation` against `America/Sao_Paulo`'s embedded IANA
tzdata already applies the historically-correct DST offset for the overwhelming majority of
timestamps — it is not the naive fixed-offset parse this section originally worried about. The one
real gap is the local calendar's two DST transition edges:

- **Spring-forward** (Brazil's clocks jumped forward, e.g. 2018-11-03 23:59:59 → 2018-11-04
  01:00:00): the wall-clock values in the skipped hour never existed. `time.ParseInLocation`
  silently normalizes them forward instead of erroring — verified live against Go's embedded
  tzdata by scanning 2000–2019 for every such gap (e.g. confirmed `2018-11-04 00:00:00` is one).
  **Fixed:** `ons/normalize.go`'s new `parseDinInstante` round-trips the parsed time back through
  the same layout string; a skipped time won't format back to its own input, so it's now rejected
  with an error (caught by the existing skip-and-log/DLQ posture, not silently mis-recorded) —
  see `TestNormalize_DSTSpringForwardGapErrors`.
- **Fall-back** (clocks repeated an hour): this is a genuine ambiguity, not an invalid time, and
  Go's stdlib exposes no way to detect it. This remains a small, **documented residual risk** — at
  most ~1 hour/year, only for years with DST (i.e. before 2019) — rather than a blocking gap: the
  alternative (guessing which of the two occurrences is correct) would silently fabricate
  certainty ONS's own data doesn't provide, which the project's "no synthetic data" posture argues
  against more than an occasional, logged skip does.

This is a best-effort resolution from static analysis and Go's own tzdata, not the live
comparison against ONS's real-time dashboard the original `[VERIFY]` called for — that comparison
still hasn't been done and would be the way to confirm ONS's own recording convention actually
matches standard Brazilian civil time (as opposed to, say, a fixed offset ONS applies regardless
of the calendar's DST rule for that date). Do that comparison before the ONS backfill's full run,
per §2.3's pilot-chunk step.

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

### 2.6 Compression policy — deliberately NOT an auto-applied migration

No compression policy or retention policy exists anywhere in this repository today — confirmed by
a repo-wide grep. Decades of dense hourly data (order-of-magnitude estimate for ONS alone: ~25
years × 8760 hours × 200+ plants ≈ tens of millions of rows) will otherwise accumulate
uncompressed indefinitely, so this is still real, needed work — but **not as a checked-in
migration file**, for a reason discovered during implementation, not anticipated when this section
was first drafted.

**Resolved (web research, 2026-08-27), and it changes the plan:** the `[VERIFY]` this section
originally deferred — `INSERT ... ON CONFLICT` behavior against compressed hypertable chunks — is
a **known, still-open TimescaleDB limitation**, not a settled, checkable fact with a safe answer.
Multiple open TimescaleDB GitHub issues (as of this research pass) confirm `ON CONFLICT` does not
reliably work against compressed chunks: a batched `INSERT ... ON CONFLICT DO NOTHING` can exit
prematurely on the first conflict instead of continuing through the remaining rows, `ON CONFLICT`
is documented as unsupported on compressed chunks generally, and upserts into compressed chunks
are separately reported as slow. `apps/consumer`'s idempotent write path (docs/architecture.md
§4) *is* an upsert on this exact unique index — this is not a hypothetical edge case, it is the
project's core correctness guarantee for exactly the write pattern a backfill (and any subsequent
live-poll overlap or resumed chunk) depends on.

This invalidates the original mitigation. A 90-day `compress_after` buffer only protects **live
polling's own lookback windows** (ENTSO-E: 2h; EIA: 5 days; ONS: whole-month re-fetch) — it does
nothing for a **backfill**, whose whole purpose is inserting rows with `recorded_at` values that
are already years old the moment they're written. If `apps/consumer/migrations/`'s unconditional,
apply-on-every-startup migration runner (`db.ts:21-27`) shipped this policy today, TimescaleDB's
background compression job would start compressing 2000-era ONS chunks within its own schedule —
independent of, and likely faster than, a multi-day backfill run — hitting the broken-`ON
CONFLICT` path on the very rows a resumed or replayed backfill chunk needs to upsert safely.

**Revised decision:** do not add `apps/consumer/migrations/0003_readings_compression.sql`. Since
this repo's migration runner has no gating mechanism (no flags, no manual-apply marker — every
`.sql` file present applies unconditionally on next deploy, `db.ts:21-27`), the only way to honor
this section's own original sequencing rule ("enable this policy only after each provider's older
ranges are substantially backfilled") is to keep the SQL out of the auto-applied `migrations/`
directory entirely until that's actually true — the same reasoning §2.5 already applied to
`refresh_continuous_aggregate` ("document as an operator runbook step... not a new script file").
Run this by hand, per provider, only after that provider's full-depth backfill is confirmed
complete and stable:

```sql
ALTER TABLE readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'source, zone, metric',
  timescaledb.compress_orderby = 'recorded_at DESC'
);

SELECT add_compression_policy('readings', INTERVAL '90 days', if_not_exists => TRUE);
```

(via `railway ssh --service timescaledb -- psql "$DATABASE_URL" -c "..."`, the same command
pattern as §2.7's backfill-execution note). `compress_segmentby = 'source, zone, metric'`
deliberately mirrors both the idempotency key's non-time columns (`0001_readings.sql`) and
`generation_hourly`'s own `GROUP BY` (`0002_generation_hourly.sql`). Once every targeted provider's
backfill is done and no further replays/resumes are expected against pre-90-day-old data, the
policy's ongoing behavior for *live* polling's narrow lookback windows is safe by the original
90-day-buffer reasoning — the risk this section now flags is specific to compressing chunks a
backfill (or its resume/replay) might still need to write into, not to running the policy at all,
forever.

**Promoting this to a real migration file later:** once all three providers' backfills are
complete and this has been confirmed safe in practice, moving this SQL into
`apps/consumer/migrations/0003_readings_compression.sql` becomes reasonable — at that point there
are no more upserts landing on years-old chunks, so the `ON CONFLICT` limitation above no longer
applies to any write this system makes. That migration is a candidate follow-up task, not part of
this one.

- **No retention policy.** Still explicitly out of scope — the entire point of this task is to
  acquire decades of history for future analytics; an auto-delete retention policy would directly
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
network, not from a local machine pointed at a public broker address.

**`railway ssh --service ingest -- ...` does NOT work — confirmed live, 2026-08-27, not just
verified-on-paper.** `railway ssh --service ingest -- echo ok` fails with "your container does not
have a shell (bash or sh)": `apps/ingest/Dockerfile:14` deploys on
`gcr.io/distroless/static-debian12:nonroot`, a real shell-less image (chosen deliberately for a
smaller attack surface, per the Dockerfile's own CGO_ENABLED=0/static-binary comment), and
Railway's SSH exec mechanism requires a shell in the target container regardless of what command
is passed. This invalidates this section's original plan and the general "`railway ssh` CLI
syntax works" finding from earlier research — that finding was correct about the CLI's own syntax,
just never checked against this specific distroless image, which is the part that actually
matters here.

**Revised plan: skip `railway ssh` entirely — run backfill as its own one-off Railway deployment
instead.** A normal Railway deployment execs the container's `ENTRYPOINT` directly
(`apps/ingest/Dockerfile:16`'s `ENTRYPOINT ["/ingest"]`) — that path never needs a shell, only
`ssh`'s interactive/exec-into-a-running-container path does. So the backfill doesn't need shell
access at all; it needs a deployment whose process *is* the backfill run:

1. Add a second Railway service in `.railway/railway.ts` — e.g. `ingest-backfill` — built from the
   same `apps/ingest/Dockerfile` and reusing `ingest`'s private-network env vars
   (`REDPANDA_BROKERS`, `ENTSOE_API_TOKEN`, `EIA_API_KEY`), but with its own start command that
   appends the `--backfill*` flags, e.g. a Railway service `startCommand` override of
   `/ingest --backfill=entsoe --backfill-from=2015-01-05 --backfill-to=2026-07-01`. Being a
   distinct service means it can be deployed, watched, and torn down without touching the
   always-on live-polling `ingest` service at all.
2. Deploy it (`railway up --service ingest-backfill` or via `railway.ts`'s existing config-as-code
   flow), then watch progress with `railway logs --service ingest-backfill` — the same per-chunk
   `log.Printf` lines this task's driver already emits are exactly what this is for.
3. The process exits cleanly (`runBackfill` returns nil) when the range is done; Railway will show
   the deployment as stopped/crashed depending on how it interprets a clean exit(0) from a
   non-restarting service — cosmetic, not a correctness issue, but confirm this live before
   relying on Railway's own status display to mean "done."
4. Delete or pause the `ingest-backfill` service between runs (per provider, or per resume) rather
   than leaving it deployed — it's a one-off job, not a fourth persistent service.

**Validated live, 2026-08-27.** The `ingest-backfill` service was created via `.railway/railway.ts`
+ `railway config apply` (confirmed zero destructive drift via `railway config plan` first, per
the process `docs/tasks/TASK-railway-deploy.md §7` already learned to use after a past near-miss).
Two things learned only by actually running it, neither of which was obvious in advance:

- **`preserve()` does not copy env vars between services** — it only protects an *existing* var
  from deletion on `apply`. A brand-new service has nothing to preserve, so `ingest-backfill`
  came up with no `REDPANDA_BROKERS` at all, silently fell back to `main.go`'s
  `localhost:19092` default, and hung indefinitely inside `pub.Publish` trying to reach a broker
  that doesn't exist in that container — no error, no log line, just silence. Fixed by explicitly
  `railway variable set`-ing `REDPANDA_BROKERS`/`READINGS_TOPIC`/`MAX_IN_FLIGHT`/`POLL_INTERVAL`
  (copied from `ingest`) and, before the real pilot, `ENTSOE_API_TOKEN`. **Anyone standing this
  service back up for a future run must set these explicitly — they are not inherited.**
- **Railway's own log ingestion caps at 500 logs/sec per replica and silently drops the rest**
  (`Messages dropped: N` lines appear in `railway logs` output). ONS's per-skipped-row logging hit
  this immediately even on a single current-month `--once` run. For the eventual full ONS
  backfill (25 years, hundreds of plants), do not rely on `railway logs` scrollback as the
  completion signal — use `/pipeline-health`'s `dlqDepth`/`consumerLag`/`lastSuccessAt` instead,
  which reflects the real database state regardless of dropped log lines.

With those two fixes, the mechanism worked cleanly end to end: a real `/ingest --once` run
(current-month ONS, hundreds of plants) round-tripped through Redpanda → consumer → TimescaleDB
with `dlqDepth: 0` and `consumerLag: 0`; the `ingest-backfill` service showed `Completed` (clean
exit, no restart loop) rather than looping. The real ENTSO-E pilot this section calls for was then
run for real — `--backfill=entsoe --backfill-from=2026-07-01` (~8 weeks, all 6 zones) — and
finished cleanly: `dlqDepth: 0`, `consumerLag: 0`, and the final logged chunk
(`zone=NL start=2026-07-01T00:00:00Z`) exactly matched `--backfill-from`, confirming the
newest→oldest walk correctly reached and stopped at the requested floor. The only skipped rows
were `unmapped psrType "B17"` (Waste) — an already-documented, deliberate exclusion
(`entsoe/normalize.go:16-17`), not a bug. §2.5's manual `refresh_continuous_aggregate` call was
then run for the backfilled range, and the data confirmed visible through
`GET /generation-mix?source=ENTSOE&zone=NO-NO1&...` — real July 2026 hourly hydro/wind/solar
values, not just present in the raw table.

**Volume/backpressure:** the `redpanda-volume` is provisioned at 5000MB
(`.railway/railway.ts:12`) — a real capacity constraint if a backfill produces messages faster
than the single-replica `persist` consumer group can drain them. This is the primary justification
for conservative, operator-tunable inter-chunk pacing (`--backfill-rate-limit-delay`) rather than
running each provider's chunks at full speed.

**Resumability:** deliberately *not* a new checkpoint file or a new Postgres-read dependency in
`apps/ingest` (it currently has none — it only talks to Redpanda, via
`apps/ingest/internal/publish/redpanda.go`). Correctness across restarts is guaranteed by the
existing idempotency index **as long as the chunk being replayed isn't sitting on a compressed
hypertable chunk** — which is exactly why §2.6 now insists compression stays unapplied until
backfill is done, rather than relying on a time-based buffer alone. With that precondition held,
replaying any already-completed chunk is always safe. Efficiency is handled by logging one
structured line per completed chunk (mirroring the existing `log.Printf("ingest: ons: poll
complete: published=%d skipped=%d")` pattern, now also emitted per backfill chunk — see
`fetchAndPublishONSMonth`/`backfillONS`/`backfillEntsoe`/`backfillEIA` in `main.go`), with
`--backfill-resume-from` set from the last logged chunk boundary on restart. Worst case on
imperfect resume bookkeeping: some redundant re-fetch/re-publish work, never duplication or
corruption.

**Progress observability:** no new subsystem — the same structured per-chunk log lines, plus the
existing `/pipeline-health` endpoint (already reporting DLQ depth, consumer lag, and
last-successful-poll-per-source per `docs/architecture.md §5`). Watch consumer lag live during a
run as the signal for whether pacing needs to slow down.

### 2.8 ENTSO-E full-depth backfill — complete (2026-08-28)

Ran to completion via `ingest-backfill` (`start: "/ingest --backfill=entsoe
--backfill-from=2015-01-05"`), all 6 zones, ~5.7 hours wall-clock (20:31→00:20 UTC). Final result:
`dlqDepth: 0`, `consumerLag: 0`, `failed_chunks=45` out of ~852 attempted (~5.3%) — all transient
upstream errors from ENTSO-E's own backend (`Acknowledgement_MarketDocument`, error code 999,
"I/O error... Timeout deadline"), correctly logged and skipped rather than aborting the run
(§2.7's resilience fix, added mid-run after attempt #1 died on its very first chunk — see below).
`refresh_continuous_aggregate('generation_hourly', '2015-01-01', '2026-08-28')` run afterward;
spot-checked via `GET /generation-mix?source=ENTSOE&zone=NO-NO1&from=2016-06-01...` — real 2016
hourly hydro data confirmed visible through the API, not just present in the raw table.

**Bug found and fixed mid-run:** the first full-depth attempt died on its very first chunk — a
single transient ENTSO-E timeout exhausted `doWithRetry`'s 3 attempts and returned an error that
`backfillEntsoe` treated as fatal, aborting the entire ~800-chunk job. At this scale, an occasional
upstream hiccup over many hours is expected, not exceptional. Fixed (`apps/ingest/main.go`,
commit `beb6096`): `backfillONS`/`backfillEntsoe`/`backfillEIA` now log a failed chunk and continue
to the next one — matching the DLQ's existing "skip and log, never abort the batch" posture — and
return a `failedChunks` count, logged as a final summary line
(`ingest: entsoe: backfill complete, failed_chunks=N`).

**The 45 failed chunks are real, precisely-located gaps** — found via a gap-detection query
against `readings` directly (log retention had already rotated past the individual `chunk FAILED`
lines by the time the run finished, several hours later — a real limitation worth noting for next
time: `railway logs`' retention window is not a substitute for `/pipeline-health` or a DB query as
the source of truth for a multi-hour run):

```sql
WITH hours AS (
  SELECT zone, recorded_at,
         LAG(recorded_at) OVER (PARTITION BY zone ORDER BY recorded_at) AS prev
  FROM (SELECT DISTINCT zone, date_trunc('hour', recorded_at) AS recorded_at
        FROM readings WHERE source = 'ENTSOE' AND recorded_at >= '2015-01-01') t
)
SELECT zone, prev AS gap_start, recorded_at AS gap_end, (recorded_at - prev) AS gap_length
FROM hours WHERE recorded_at - prev > interval '1 day' ORDER BY zone, gap_start;
```

Results: gaps in exact 30-day multiples (30/60/90/150/300 days) on `NL` (4 gaps), `NO-NO2` (3),
`NO-NO4` (5), `NO-NO5` (1) — these are the 45 failed chunks. Separately, every Norwegian zone
(`NO-NO1` through `NO-NO5`, **not** `NL`) shares two identical ~1–2 day gaps at 2015-08-06/07 and
2015-10-17/19 — same dates across five independent zones strongly suggests a real ENTSO-E platform
outage on those dates, not a bug in this pipeline; not counted among the 45 chunk failures (too
small to be a 30-day chunk boundary, and it predates this backfill entirely — it would show up in
live-polled data too if the platform had been queried on those exact days in 2015).

**Follow-up, not yet done:** targeted gap-fill re-runs for the 45 identified ranges (e.g.
`--backfill=entsoe --backfill-from=2017-05-01 --backfill-to=2017-07-01` to refill `NO-NO4`'s
2017-05/06 gap — harmless to also re-request the other 5 zones' already-complete data for that
narrow window, since it's idempotent) — left for a deliberate follow-up rather than done
automatically, same as the rest of this task's "no full-depth run without a human in the loop"
posture.

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

- `apps/ingest/main.go` — new `--backfill*` flags (`--backfill`, `--backfill-from`,
  `--backfill-to`, `--backfill-resume-from`, `--backfill-rate-limit-delay`); extracted
  `fetchAndPublishONSMonth`/`fetchAndPublishEntsoeWindow`/`fetchAndPublishEIAWindow` helpers shared
  by live polling and backfill; `runBackfill` dispatcher and per-provider
  `backfillONS`/`backfillEntsoe`/`backfillEIA` driver loops (newest→oldest, resume logging).
  **Implemented 2026-08-27.**
- `apps/ingest/internal/ons/client.go` — no interface change (`FetchMonth` already fits); added
  `doWithRetry` wrapping the HTTP call with 3-attempt exponential backoff. **Implemented.**
- `apps/ingest/internal/ons/normalize.go` — DST spring-forward-gap detection (§2.4), resolving the
  existing `[VERIFY]` at `normalize.go:14-19` as far as static analysis can (a live comparison
  against ONS's own dashboard remains a pre-full-run step, not a code change). **Implemented.**
- `apps/ingest/internal/entsoe/client.go` — no interface change (`FetchActualGeneration` already
  fits); added its own `doWithRetry`. **Implemented.**
- `apps/ingest/internal/eia/client.go` — no interface change (`FetchFuelTypeData` already fits);
  added its own `doWithRetry`. **Implemented.**
- `apps/consumer/migrations/0003_readings_compression.sql` — **deliberately NOT added**; see §2.6's
  revised decision. The compression SQL is documented as an operator runbook command instead, to
  be run manually per provider after that provider's backfill is complete.
- `packages/contracts/src/event.ts` and `apps/ingest/internal/event/event.go` — untouched; no
  zone-enum pilot has surfaced an unmapped code yet (§2.3's pilot step is still an operator
  verification step ahead of a full-depth run, not something this pass could exercise without
  hitting the live APIs).
- Tests added: `apps/ingest/main_test.go` (ISO date parsing, rate-limit-delay override, backfill
  dispatch error paths, `backfillONS`'s chunk-boundary/error-propagation logic via a swappable
  `fetchAndPublishONSMonthFn` seam — mirroring `eia/client_test.go`'s `baseURL` swap pattern);
  `apps/ingest/internal/ons/normalize_test.go` (`TestNormalize_DSTSpringForwardGapErrors`, using a
  real gap date verified against Go's embedded tzdata: 2018-11-04 00:00:00).

## 5. Verification

`[VERIFY]` items, resolved during implementation (2026-08-27, web research — see inline citations
in §2.2/§2.4/§2.6 above for what was found and how it changed the plan):

- ENTSO-E's maximum request time span for document type A75 — **resolved**: ~1 year; chunk width
  set to 30 days, well under that.
- ENTSO-E's rate limit — **resolved**: 400 req/min per token; default delay set to 1s/chunk.
- EIA's rate limit — **not found**; shipped with a conservative 2s/chunk default instead of a
  confirmed number (§2.2).
- TimescaleDB `INSERT ... ON CONFLICT` behavior against compressed chunks — **resolved, and it's
  bad news**: a known, still-open limitation. This changed §2.6's plan from "ship a migration with
  a safety-buffer `compress_after`" to "don't auto-apply the policy until backfill is done," not
  just a note-taking exercise.
- `railway ssh`'s CLI semantics — **checked live, and it changed the plan**: the syntax itself
  works, but `railway ssh --service ingest -- ...` cannot run anything against this specific
  service — its container has no shell (`apps/ingest/Dockerfile:14`'s distroless nonroot base).
  §2.7 now documents a `railway ssh`-free replacement (a dedicated one-off deployment whose start
  command *is* the backfill invocation) instead.

Still open, deliberately left as operator/runtime verification rather than something resolvable by
further static research:

- A live comparison of `din_instante` against ONS's own real-time dashboard, to confirm its
  recording convention actually matches standard Brazilian civil time (§2.4) — do this before the
  ONS backfill's full run, not before its code ships.
- §2.3's pilot-chunk + DLQ-inspection step, for ONS and EIA, before any full-depth run.
- Watch `/pipeline-health` consumer lag live during each run; confirm `generation_hourly` reflects
  each backfilled range only after its corresponding manual `refresh_continuous_aggregate` call
  (§2.5), not before.
- Run the §2.6 compression SQL by hand, per provider, only once that provider's backfill is
  confirmed complete — not bundled into this task's code changes.

This task does not include actually executing a full-depth backfill against production — that is
a deliberate, monitored operator action taken after this design is implemented and reviewed, not
an automatic consequence of merging the code.
