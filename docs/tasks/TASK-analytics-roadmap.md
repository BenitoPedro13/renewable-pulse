# TASK-analytics-roadmap

**Status: roadmap, not an implementation-ready task.** Unlike other `docs/tasks/` docs, this one
is deliberately scope-setting rather than build-ready — it depends entirely on
`docs/tasks/TASK-historical-backfill.md` landing first, and each phase below needs its own
alignment/design pass (concrete table DDL, exact endpoint contracts, model/library choices)
before any of it is implemented. Written with real technique names and formulas rather than vague
"ML"/"AI" language specifically so a future planning pass has something concrete to react to and
narrow down, not a blank page.

## 1. Current scenario

The dashboard (Phase 4, `docs/tasks/TASK-live-dashboard.md`) presents real-time and short-window
generation-mix data: composition breakdowns, plant maps and leaderboards, a volatility chart
(coefficient of variation per fuel type), and a pipeline-transparency panel. Every number on it is
either a live reading or a simple aggregate (sum, share, coefficient of variation) computed
directly in SQL against `generation_hourly` or `readings` — there is no derived/statistical
analysis layer, no forecasting, no anomaly detection, and no researcher-oriented export or bulk
access.

Every existing derived-data consumer in this system reads TimescaleDB directly rather than
re-consuming the Kafka event stream — every `/generation-*` route in `apps/api/src/routes/`
queries `generation_hourly`/`readings` through the shared `pg.Pool` in `apps/api/src/db.ts:1-10`,
never Redpanda. There is **no precedent anywhere in this repository for a non-Go, non-TypeScript
service** — the stack table in `CLAUDE.md` names exactly Go (`apps/ingest`) and TypeScript
(`apps/consumer`, `apps/api`, `apps/web`). Introducing Python is a genuine new architectural seam,
not an incremental addition, and should be named as such rather than slipped in as a detail.

This roadmap assumes `TASK-historical-backfill.md` has landed and produced real multi-year
history per provider (Brazil ~25 years, Europe ~11 years, USA ~8 years hourly) — without that,
none of the phases below have enough data to compute anything meaningful.

## 2. Proposed architecture

### 2.1 A scheduled Python batch service, reading/writing TimescaleDB directly

Matches the existing pattern (`generation-mix.ts` et al. reading Timescale directly) rather than
introducing Kafka consumer-group semantics a third time (`apps/consumer`'s `persist` group and
`apps/api`'s in-process `live` group already exist and would be genuinely new complexity to
duplicate for a batch workload that doesn't need per-event delivery guarantees).

- New service directory, e.g. `apps/analytics/` (Python), deployed as a **sixth Railway service**
  following the exact `source: empty()` / Dockerfile-build pattern `apps/consumer` already uses
  in `.railway/railway.ts`.
- Needs only a `DATABASE_URL` env var — no Redpanda broker access, since it reads already-persisted
  data and writes new derived tables, mirroring exactly what every `/generation-*` API route
  already does from the TypeScript side.
- Runs on an internal schedule (a simple interval loop, matching `apps/ingest`'s own
  `POLL_INTERVAL`-driven ticker pattern in `main.go:55-64` — no new scheduling infrastructure
  needed) rather than depending on an external cron system.
- Suggested library stack (needs its own verification pass against current docs before adoption,
  per this repo's "verify against each tool's own current docs" convention): `pandas`/`numpy` for
  data handling, `SQLAlchemy` or plain `psycopg` for the DB layer, `statsmodels` and/or `prophet`
  for forecasting, `scikit-learn` for clustering, `ruptures` for change-point detection.

### 2.2 New migration: derived-metrics tables (sketch, not final DDL)

`apps/consumer/migrations/0004_analytics.sql` (numbered after `0003_readings_compression.sql`
from the backfill task) — one table per derived-metric family, each keyed consistently with the
existing schema discipline: `(source, zone, metric?, window_start, window_end, computed_at)`,
mirroring `readings`' `(source, zone, asset_id, metric, recorded_at)` and `generation_hourly`'s
`GROUP BY (source, zone, metric, unit)`. Exact DDL is deferred to each phase's own design pass
(§3) — this is a naming/keying convention to keep consistent across phases, not a schema to build
against yet.

### 2.3 New API routes

Modeled explicitly on the existing route shape — `apps/api/src/routes/generation-mix.ts` (Zod
query schema from `@renewable-pulse/contracts` → one parameterized `pool.query` → response mapped
through a Zod response schema before returning) is the cleanest template to copy. One new route
file per derived table, one new Zod schema pair per route in `packages/contracts/src/api.ts`
(alongside the existing `MAX_HOURLY_DAYS`/`MAX_DAILY_DAYS` range caps, `api.ts:4-5` — a
history-spanning analytics route will need its own, wider range schema rather than reusing the
365-day cap built for the live dashboard's needs).

## 3. Phases (proposed order: descriptive → anomaly/change-point → forecasting → researcher
tooling — cheapest and most defensible first, per alignment already reached with the user; each
still needs its own design pass before implementation)

### 3.1 Descriptive statistics

The cheapest, most defensible category: no prediction, purely better ways to describe data that's
already real and already ingested.

- **Diversity index** — Shannon entropy `H = -Σ pᵢ·ln(pᵢ)` over each zone's normalized fuel-mix
  shares. A single interpretable "energy diversity score" per zone/period — high entropy means no
  one fuel dominates, low entropy means concentration in one or two sources. Cheap to compute,
  intuitive to present to a general audience, and a natural cross-zone leaderboard.
- **Capacity factor** — `actual output ÷ rated capacity`, tracked over time per plant/zone. Both
  EIA-860 (USA) and ONS plant capacity data are **already ingested and currently unused for this**
  (confirmed during backfill-task research: `apps/api/src/routes/plants.ts` surfaces capacity for
  display, but nothing computes a factor from it) — this is likely the single most
  research-credible metric on this list, and one of the cheapest to add since the raw inputs
  already exist in the database.
- **Record tracking** — statistically detect rolling all-time/period highs and lows per
  zone/fuel/metric (e.g. "highest wind share on record for Norway"). Purely descriptive of real
  data, no modeling assumptions, and a strong "engaging content" hook for casual visitors once
  enough history exists to make records meaningful.

### 3.2 Anomaly and change-point detection

- **Point anomalies** — STL (seasonal-trend decomposition using LOESS) on each zone/fuel's hourly
  series, followed by z-score or IQR thresholding on the residual component, to flag unusual
  spikes/dips as a browsable "notable events" feed. Framed as *describing* real data (an
  unusually large deviation from the expected seasonal pattern), never as a prediction — stays
  cleanly inside the no-synthetic-data ethos.
- **Structural change-points** — PELT (Pruned Exact Linear Time), via Python's `ruptures` library,
  applied to a zone's fuel-mix time series to detect step-changes (e.g. "Norway's wind share
  stepped up in March 2019"). This is the category most directly unlocked by the historical-depth
  work in `TASK-historical-backfill.md` — with only weeks of data, there's nothing structural to
  detect; with years, genuine energy-transition inflection points become visible. Strong hook for
  a researcher audience specifically.

### 3.3 Forecasting

Short-horizon (6–24h) per-zone generation-mix forecasts, via classical statistical models
(`statsmodels` ARIMA/ETS, or Prophet) or gradient boosting on lagged/calendar features. This is
the one category that needs explicit design care around the project's core invariant: **a
forecast must never be rendered or stored in a way that could be mistaken for a real reading.**
Concretely: forecasts are a clearly-labeled *derived* output (their own table, their own API
field, their own visual treatment — dashed lines, a distinct color, an explicit "predicted" label)
computed from real historical inputs, never merged into or backfilling gaps in the `readings`
table itself. This is the same posture the project already takes toward "missing data shown as
missing, not faked" — a forecast is not synthetic data if it's honestly labeled as a forecast; it
becomes a violation only if presented as if it were an actual reading.

### 3.4 Researcher tooling

- **Bulk export** — CSV/Parquet download over the full backfilled history, likely the single
  highest-value/lowest-complexity item in this entire roadmap once `TASK-historical-backfill.md`
  has landed: it doesn't require any new statistical technique, just productizing what backfill
  already produces. Effectively turns the pipeline into a citable data source for external
  research, which is a distinct and substantial value proposition from anything currently on the
  dashboard.
- **Cross-zone clustering** — k-means or hierarchical clustering on normalized zone fuel-mix
  vectors, surfacing "which grids behave alike" (e.g. do certain US balancing authorities cluster
  with Norway's hydro-heavy profile, or is that a genuine outlier).
- **Cross-zone correlation** — correlation matrices between zones' generation series (e.g. does
  Norwegian hydro dispatch correlate with Danish/German wind availability at the interconnector
  level) — a real research question the current per-zone-only views can't answer.

### 3.5 A note on historical depth ceilings

Every phase above inherits the depth ceilings established in `TASK-historical-backfill.md §1`:
Brazil supports genuinely ~25-year hourly analysis; Europe ~11 years; the USA ~8 years at the
hourly grain currently ingested. A future, explicitly separate task could extend US history much
further by additionally polling EIA's monthly/annual Form 923/860 plant-level series (back to
1970/1949) — noted here as a real, undecided future extension, not committed to by this roadmap.

## 4. Why

This is the layer that turns "a live dashboard of current numbers" into something a returning
visitor or a researcher gets ongoing value from — patterns, trends, and comparisons that only
exist once there's enough real history to compute them over, using classical statistics and
non-LLM machine learning (entropy, decomposition, change-point detection, classical forecasting,
clustering) that stay fully inside this project's "every reading traces to a real API response"
ethos, since every technique here is a transformation of real ingested data, never a generator of
new synthetic data.

## 5. Affected files (once a phase is actually scheduled — not this round)

- `apps/analytics/` (new Python service directory)
- `apps/consumer/migrations/0004_analytics.sql` (new, per-phase tables)
- `apps/api/src/routes/*.ts` (new route per derived table)
- `packages/contracts/src/api.ts` (new Zod query/response schema pairs)
- `.railway/railway.ts` (new sixth service block)
- `docs/architecture.md` (new section documenting the Python service as a named architectural
  seam, once it exists)

## 6. Verification

Not applicable yet — this is a roadmap document, not an implementation task. Each phase gets its
own `docs/tasks/TASK-<slug>.md` with a real Verification section once it's individually scheduled
and designed.
