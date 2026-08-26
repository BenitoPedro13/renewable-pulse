# TASK-live-dashboard

## 1. Current scenario

Phases 1 and 2 are shipped and live-verified: real ONS readings flow through
`apps/ingest` → Redpanda topic `readings` → the `persist` consumer group → TimescaleDB →
`apps/api`. The reference ONS run persisted 366,336 real plant/hour readings with zero new rows
on replay. Malformed readings route to `readings.dlq`, batched persistence is bounded and
idempotent, and `GET /pipeline-health` reports real DLQ depth, `persist` consumer lag, and the
last persisted `ingested_at` for each configured source.

Phase 3 is code-complete. EIA has been verified against the live API. ENTSO-E normalization and
publishing are implemented and unit-tested, but live verification remains pending until an API
token is issued. A missing ENTSO-E source must therefore remain visibly missing in Phase 4; the
web app must not substitute fixtures, generated points, or a hard-coded Norway series.

The repository currently has no `apps/web`, no public WebSocket route, no `live` Redpanda consumer
group, and no TimescaleDB continuous aggregate. `GET /readings?since&limit` returns raw canonical
events and is not an appropriate chart query for hundreds of thousands of plant/hour rows.

The source units are intentionally not interchangeable:

- ONS publishes hourly-average generation as `MWmed`.
- ENTSO-E publishes power as `MAW`.
- EIA publishes hourly energy totals as `MWh`.

Phase 4 must never add these values into a shared absolute-generation series. The Brazil view can
aggregate ONS values because its rows share `MWmed`. A dimensionless within-source ratio can be
compared across countries without mixing MWmed/MAW/MWh, but the current canonical categories are
not precise enough to call that ratio total “renewable share”: ENTSO-E biomass is normalized into
`thermal`, while EIA geothermal and storage are normalized into `other`. V1 therefore labels the
comparison exactly as **hydro + wind + solar share of observed generation**. A future true
renewable-share claim requires preserving source fuel classifications or a source-backed
renewability flag through ingest; Phase 4 must not infer one from the lossy metric buckets.

This is Phase 4 of `docs/tasks/TASK-implementation-plan.md` §2. Per `CLAUDE.md`, this document is
the only Phase 4 change until it has been reviewed. No application or migration files are to be
created or edited during the planning pass.

## 2. Planned changes

**Progress note (2026-08-26):** §2.1–2.3 (contracts, continuous aggregate, live consumer) are
done and test-covered against real TimescaleDB/Redpanda testcontainers. §2.4's AlignUI CLI step,
shadcn `chart` component, and `zustand`/`@tanstack/react-query` install are done; the categorical
palette resolved to hydro=information(blue)/solar=primary(orange)/wind=stable(teal)/
thermal=error(red)/other=feature(purple) — **not** `warning`, since with Orange as the resolved
primary, `--color-warning-base` *is* the same ramp as `--color-primary-base` (`docs/brand.md` §2).
The state/provider architecture (`src/providers/query-provider.tsx`,
`src/providers/live-store-provider.tsx` + `live-client-provider.tsx`, `src/stores/live-store.ts`,
`src/lib/live-client.ts`, one `queryOptions` factory + abstracted hook per REST endpoint) is built
and verified live in a real browser against the running stack: the live indicator reaches
"Live" (green) and the Pipeline Health section (§2.5.3) renders real DLQ depth/consumer
lag/last-poll data with the correct "Not observed" state for ENTSOE/EIA. Brazil deep-dive and
country comparison are now both built, verified against the real running stack (`apps/ingest` and
`apps/consumer`'s `persist` group started for real — the database previously held only a one-time
historical ONS backfill, no process was left running). Beyond §2.5's plan, both sections now also
show real per-subsystem/per-source composition and diurnal patterns, not just the single hydro+
wind+solar share number — see the deviation note below §2.1. The map renders real ANEEL SIGA
markers (Mapbox token supplied from Flora's own `.env`, per `docs/brand.md`'s "browser-safe public
client env var" rule) after a real bug was found and fixed: ANEEL's own CKAN resource repeats the
same CEG across rows (a "daily" resource queried without a date filter), so `apps/api/src/routes/
plants.ts` now dedupes by CEG. §2.6's documentation/verification closeout is not yet done.

**Deviation from the original plan (2026-08-26, user-requested):** `GET /generation-mix`'s
`source` param, originally scoped to the literal `"ONS"` (§2.1 below, for the Brazil chart only),
is widened to accept any `sourceSchema` value — used for a real full generation-type composition
comparison (Brazil vs USA), not just the single-number hydro+wind+solar share
`GET /generation-share` already provided. The single-share endpoint/label stays as designed; the
composition views are additive, each still strictly source-scoped so MWmed/MAW/MWh are never
combined across sources.

### 2.1 Lock the API and live-message contracts first

Extend `packages/contracts/src/api.ts` before implementing a route or UI that depends on it. The
planned internal API is:

1. **`GET /generation-mix`** for the Brazil stacked-area chart.
   - Query: `source=ONS`, one or more ONS `zone` values, `from`, `to`, and `bucket=hour|day`.
   - Response rows: `{ bucketStart, source, zone, metric, value, unit, readingCount }`.
   - `value` is the sum of real readings in that source/zone/metric/bucket only. `unit` remains in
     the response and SQL grouping key so unlike units can never be merged silently.
   - The route rejects a range/bucket combination that would return an unbounded chart payload;
     exact maximum ranges and row limit are recorded in the Zod query schema, route tests, and
     README rather than relying on “reasonable” defaults.
2. **`GET /generation-share`** for the country small multiples.
   - Query: one or more `source=ONS|ENTSOE|EIA` values, `from`, `to`, and `bucket=day` for v1.
   - Response rows: `{ bucketStart, source, share, includedMetrics, includedValue, totalValue,
     unit, observedIntervals }`.
   - `observedIntervals` is the count of distinct hourly buckets that contributed to the returned
     source/day ratio, not the number of raw plant/fuel rows. This lets the UI expose incomplete
     daily coverage without manufacturing missing hours.
   - `includedMetrics` is exactly `["hydro", "wind", "solar"]`. `thermal`, `nuclear`, and
     `other` remain in the denominator but not the numerator. The endpoint and UI use the exact
     “hydro + wind + solar share” label, not “renewable share”. This definition is encoded once in
     the route/query module and covered by literal SQL-result assertions.
   - Results stay source-scoped through ratio calculation. `MWmed`, `MAW`, and `MWh` values are
     never added across sources. A source/bucket with no real observations is omitted from rows
     and represented by the web view as missing, not as zero.
3. **`GET /generation-latest`** for the Brazil map and current-value labels.
   - Query: `source=ONS` and optional ONS zones.
   - Response: the latest real reading per `(source, zone, asset_id, metric)` plus the timestamp
     and original unit. No interpolation or carry-forward beyond the latest row is performed.
4. **`GET /plants`** for verified Brazil plant geography.
   - Backed by ANEEL's official public SIGA daily CKAN resource
     `2f65a1b0-19b8-4360-8238-b34ab4693d55`, not generated coordinates. Its live schema was
     checked on 2026-08-26 and exposes `CodCEG`, `NomEmpreendimento`, `SigUFPrincipal`,
     `SigTipoGeracao`, `DscFaseUsina`, `DscOrigemCombustivel`, `NumCoordNEmpreendimento`, and
     `NumCoordEEmpreendimento`. The dataset is licensed ODbL and refreshed daily.
   - Return only rows with real coordinates, paginated/cluster-ready metadata, and explicit ANEEL
     attribution. These are plant-registry locations and attributes, not live ONS generation
     readings; the UI must never imply that a marker's registry capacity is its current output.
   - Cache successful ANEEL responses for one hour in the API process and return an unavailable
     state when the source cannot be reached. Do not check in a fabricated coordinate file.
5. **`GET /live`** WebSocket endpoint.
   - Server frames use a Zod discriminated union:
     - `{ type: "reading", reading: ReadingEvent }`
     - `{ type: "heartbeat", sentAt: ISO-datetime-with-offset }`
   - A heartbeat is operational connection metadata, not an energy reading. It is never persisted
     or displayed as source data.
   - The browser opens the socket before fetching historical/latest REST data, merges incoming
     readings by the canonical idempotency key, and then applies the REST snapshot. This avoids a
     fetch-then-connect gap where a newly published reading could be missed.

The exact endpoint names above are project-owned API decisions, not claims about an upstream
provider. Before code ships, verify them against Fastify's current WebSocket plugin API and the
actual dashboard query needs; if the implementation changes a field or route, update this task
doc and `packages/contracts` together rather than inventing a shape inside a component.

### 2.2 Add TimescaleDB continuous aggregates without hiding missing data

Add a second SQL migration under `apps/consumer/migrations/` that creates an hourly continuous
aggregate over `readings`, grouped by:

`time_bucket('1 hour', recorded_at), source, zone, metric, unit`.

The aggregate stores `SUM(value)` and `COUNT(*)`. The chart endpoints query this aggregate
directly for hourly output and roll it up in SQL for daily output. Keeping `source` and `unit` in
every grouping prevents cross-source unit mixing. No `time_bucket_gapfill`, interpolation,
last-observation carry-forward, or generated calendar series is used in v1 because those can make
missing upstream periods look observed.

Add an explicit continuous-aggregate refresh policy with `start_offset => INTERVAL '35 days'`,
`end_offset => INTERVAL '1 hour'`, and `schedule_interval => INTERVAL '1 hour'`. The local image is
`timescale/timescaledb:latest-pg17`; the current official API documentation confirms these interval
arguments and recommends excluding the latest write-heavy bucket. Thirty-five days covers a full
ONS monthly file plus late corrections, EIA's five-day overlap, and ENTSO-E's shorter window.

Tests run the migration and route queries against a real TimescaleDB testcontainer. Fixtures for
SQL integration tests may only be canonical events copied from real captured provider responses
already used by this repository; do not fabricate generation readings for convenience. Assertions
must include a missing bucket and prove that it stays absent.

### 2.3 Run the `live` consumer in the API process and fan out with bounded clients

Resolve `docs/architecture.md` §10's deployment question as follows for v1:

- `persist` remains the independent long-running process in `apps/consumer`.
- `apps/api` owns a second Redpanda consumer instance with group id `live`, because it is also the
  process that owns the in-memory set of connected WebSocket clients. This avoids adding Redis,
  another internal broker, or a private consumer→API socket solely to cross a process boundary.
- The architectural role is still the second `apps/consumer` group shown in §4, but its v1 runtime
  is co-located with `apps/api`; document that distinction in `docs/architecture.md`.
- `live` subscribes with `fromBeginning: false`, but that option only controls a brand-new group;
  an existing group can still resume a committed offset behind the log end after API downtime.
  Capture an API-startup cutoff and consume/commit older backlog without broadcasting it. Only
  readings whose Kafka record timestamp is after that cutoff may fan out. `ingested_at` remains
  source-poll metadata and is not a safe substitute for the broker arrival timestamp. Historical
  recovery comes from TimescaleDB REST snapshots, not replaying a 366k-style backlog into browsers.
- Every consumed payload is validated with `readingEventSchema` before fan-out. Invalid payloads
  are not broadcast. The `persist` group remains the single owner of DLQ publication so the same
  poison message is not duplicated in `readings.dlq` by both groups.
- Each client has a bounded send path. A slow or non-reading client is closed with an explicit
  retryable WebSocket close code instead of blocking Kafka consumption or allowing unbounded
  memory growth. Use `ws.bufferedAmount > 1 MiB` as the bound and close with WebSocket code `1013`
  (“Try Again Later”), which is the standard temporary-overload signal supported by `ws`.
- Kafka offsets are allowed to advance after the validated event has been offered to all currently
  healthy clients. Live fan-out is intentionally ephemeral; TimescaleDB plus the REST snapshot is
  the recovery path after disconnect/reconnect.
- Fastify startup connects the live consumer before accepting WebSocket clients, and shutdown
  stops the consumer, closes clients, then closes the HTTP server and database pool.
- V1 runs exactly one API+`live` replica. A Kafka consumer group divides partitions among members,
  so multiple API replicas in the same `live` group would each see only part of the stream and
  their locally connected browsers would miss readings. Record the one-replica deployment limit
  in `docs/architecture.md`/README and verify the deployment setting. Scaling the API horizontally
  requires an external fan-out layer or one all-partitions subscription per replica and is out of
  scope for this phase.

The live-consumer code belongs under `apps/api/src/live/` rather than importing an executable from
`apps/consumer`. Shared schemas continue to come from `packages/contracts`.

### 2.4 Scaffold `apps/web` with official generators

Use the current official Next.js generator, not a hand-written scaffold. The verified command is
`pnpm dlx create-next-app@latest apps/web --ts --tailwind --eslint --app --src-dir --use-pnpm
--import-alias '@/*' --disable-git --yes`. The generated app is added to the existing
pnpm/Turborepo workspace and uses the shared `packages/config` conventions where compatible.

Then use official component/design-system tooling:

- Run `pnpm dlx @alignui/cli tailwind --cwd apps/web` as required by `docs/brand.md` §2. The current
  CLI offers blue, purple, orange, and green but not yellow; select **Orange** as the closest
  built-in energy accent, **Slate** neutrals, **oklch**, no prefix, and CSS-only Tailwind v4.1
  configuration. Record the generated/modified files in `docs/brand.md`; do not hand-author a
  parallel token set.
- Apply the documented amber primary aliases, including dark-mode aliases, only where the CLI
  output requires the project-specific primary reassignment.
- Initialize shadcn/ui with its current CLI and add its chart component, which uses Recharts v3.
  Do not install another charting library.
- Use `react-map-gl` for the map, matching the established Flora pattern. Mapbox access is read
  from a documented public client env var and never hard-coded.
- `[VERIFY: run the required dataviz palette/contrast validation on hydro=information-blue,
  solar=primary-amber, wind=verified/stable teal, thermal=warning/error orange-red, and
  nuclear/other=feature-purple at the actual chart swatch/line sizes before shipping. Record any
  resolved token choices in `docs/brand.md`; no raw replacement hex values.]`
- Use Inter through `next/font/google`, matching Flora. Inter exposes tabular figures via OpenType
  `tnum`; apply `font-variant-numeric: tabular-nums` only to live metrics/timestamps.
- Install `@tanstack/react-query` and `zustand`. Server state (the four REST endpoints above)
  goes through TanStack Query; client-only state several components read (WebSocket connection
  status, heartbeat freshness, the live reading buffer) goes through a Zustand store. See
  `CLAUDE.md`'s "Frontend state conventions" for the exact provider/hook shape — verified against
  each library's own current Next.js App Router guide, not invented locally. No component calls
  `useQuery`, the live-client Context, or a Zustand store hook directly; every access goes through
  an abstracted hook in `src/hooks/`.

### 2.5 Build the dashboard from real API states

Create one responsive dashboard shell with three visible sections rather than hiding reliability
information on an admin route:

1. **Brazil deep-dive**
   - Current hydro + wind + solar share of observed generation and last real source timestamp.
   - Stacked-area generation mix from `GET /generation-mix`, using only ONS data and preserving
     the `MWmed` label.
   - A clustered plant-registry map using `GET /plants`, alongside current ONS subsystem totals
     from `GET /generation-latest`. The selected geographic source is ANEEL SIGA's verified daily
     registry, keyed by CEG and carrying authoritative coordinates. Because the current canonical
     reading stores ONS `id_ons` rather than CEG, v1 does not join individual map markers to current
     generation. Plant popovers label ANEEL registry attributes and the separate subsystem panel
     labels ONS output. Do not infer a per-plant live value or draw approximate subsystem polygons.
2. **Country comparison**
   - Three small multiples for Brazil/ONS, Norway/ENTSO-E, and USA/EIA hydro + wind + solar share
     of observed generation, not one combined absolute-generation chart and not a claim to total
     renewable share.
   - Each panel labels its source, latest observed interval, and missing state. Until ENTSO-E live
     verification/data exists, Norway renders “No verified readings yet” rather than sample data.
   - Iceland is not part of the live three-country comparison because no public polled API was
     found. The previously planned static annual figure may appear only as separately labelled
     context after its publication/source/year are verified; it must not be plotted as a live
     series.
3. **Pipeline health**
   - Render `dlqDepth`, `consumerLag`, and every `lastPollBySource` entry from the existing
     `GET /pipeline-health` contract.
   - Use tabular numerals and explicit `0`, timestamp, and `Not observed` states. Do not collapse a
     missing source into a green/healthy zero state.

The live indicator uses WebSocket/heartbeat state and shows the most recent real reading timestamp
separately. It pulses slowly only while the socket is connected and heartbeats are current. After
heartbeat timeout or socket close it becomes stale, reconnects with bounded exponential backoff,
and refreshes REST snapshots on reconnection. It does not animate fake sub-second reading updates.

Every data surface has loading, empty, partial-source, stale-connection, and API-error states. Empty
and partial states preserve the hard constraint: missing data is displayed as missing and no chart
series is padded with generated readings.

### 2.6 Documentation and configuration closeout

After implementation and verification:

- Update `docs/architecture.md` §4/§9/§10 with the API-hosted `live` consumer, continuous aggregate,
  endpoint list, and shutdown/backpressure behavior.
- Update `docs/brand.md` with the resolved AlignUI accent name, validated categorical tokens,
  tabular-number decision, actual map scope, and screenshots/behavior notes if the repo convention
  supports them.
- Update `.env.example` for the browser-safe API/WebSocket base URL, Mapbox public token, heartbeat
  settings if configurable, allowed browser origin, and any server-side live-consumer settings
  actually read by code.
- Update `README.md` status and quickstart so one documented command sequence starts infra,
  `persist`, API+`live`, ingest, and web without implying that upstream providers push data in
  real time.

The browser and API run on different local origins, so register the current official Fastify CORS
plugin and enforce a configured origin allowlist for REST and WebSocket upgrade requests. Do not
ship permissive `*` origin handling with a credential-capable WebSocket endpoint. Verify the exact
Fastify/WebSocket origin-hook API against current official docs before implementation.

Phase 4 also corrects EIA freshness before treating USA as dashboard-ready. The live verification
in `TASK-entsoe-eia-pollers.md` §5.1 proved that windows narrower than roughly one day often return
zero rows, while `apps/ingest/main.go` still uses a two-hour EIA lookback. Increase the EIA window
to a documented overlap of at least five days, covered by a Go test of the requested start/end
window. Existing idempotent writes absorb overlap; a short window must not make USA silently look
current while repeatedly polling no data.

### 2.7 Post-launch expansion, decided 2026-08-26 (user request: "amazing dashboard... more than a
percentage")

The v1 dashboard (§2.5) undersold the pipeline's actual data depth — 380k+ real hourly readings at
plant/subsystem granularity, reduced to one share number per country. User asked for genuinely
deeper real-data visualizations, USA/other-region parity (not Brazil-only), filtering, and more
statistics, and explicitly authorized proceeding without a stop-and-ask for each item ("trust ur
judgment, but document your choices").

**Decided and built:**
- `GET /generation-mix`'s `source` param widened from the literal `"ONS"` to the full
  `sourceSchema` (verified via two new contract tests) — used for a full generation-type
  composition comparison (Brazil vs USA), not just the single hydro+wind+solar share number.
  Each source's own units are still summed/normalized independently, never combined.
- Real bug found via the browser console (duplicate React marker keys) and fixed at the source:
  ANEEL SIGA's CKAN resource repeats the same CEG across rows; `apps/api/src/routes/plants.ts`
  now dedupes by CEG.
- Plant markers color-coded by real fuel type (ANEEL's `SigTipoGeracao`: UHE/PCH/CGH→hydro,
  UTE→thermal, EOL→wind, UFV→solar, UTN→nuclear — the same categories ONS's own
  `nom_tipousina` values already map to), sized by real installed capacity
  (`MdaPotenciaFiscalizadaKw`, falling back to `MdaPotenciaOutorgadaKw` when a plant hasn't been
  inspected yet — both real ANEEL fields, added to `plantSchema` as `installedCapacityKw`), with a
  click-to-inspect popup. A genuinely missing ANEEL decimal field renders as `",00"` (no integer
  part) rather than being omitted — confirmed live on `MdaGarantiaFisicaKw` — so `plants.ts`'s
  `num()` helper now treats that as missing rather than parsing it to a false `0`.
- **USA plant-level map, resolving "why can't I see US points"**: EIA's own Form 860/860M is
  exposed as a real v2 REST route, `electricity/operating-generator-capacity`, confirmed live
  (not assumed) — it returns `latitude`/`longitude`/`nameplate-capacity-mw`/`technology` per
  *generator* (4.3M+ rows across all US generators), so plant-level rows require grouping by
  `plantid` server-side the same way ANEEL's rows are deduped by CEG.  All 28 real `technology`
  facet values were fetched from EIA's own facet-metadata endpoint (not guessed) and mapped to the
  canonical metric enum using the same reasoning already applied to EIA's 16 `fueltype` codes in
  `TASK-entsoe-eia-pollers.md` §5.1 (combustion variants → `thermal`, `Geothermal`/`Batteries`/
  `Flywheels`/`All Other`/null → `other`, `Hydroelectric Pumped Storage` → `hydro` matching the
  existing `PS`→hydro precedent). `GET /plants` gains a `source=ANEEL_SIGA|EIA_860` query param
  (default `ANEEL_SIGA`, preserving existing behavior); `plantsResponseSchema.source` widens from
  the `"ANEEL_SIGA"` literal to that enum. `EIA_API_KEY` is now read by `apps/api` as well as
  `apps/ingest` (documented in `.env.example` accordingly) — this route is a live pass-through
  proxy with an hourly cache, like the existing ANEEL branch, not part of the Kafka
  ingest/persist pipeline, so no Go or `packages/contracts` event-schema changes are needed.

**Also built this session:**
- A real bug in `apps/web/src/lib/queries/generation-mix.ts`: the `source` param was hardcoded to
  `"ONS"` even after the route/schema were widened above, so `CompositionComparisonChart`'s USA
  branch was silently querying `source=ONS&zone=US-US48` (zero rows) instead of EIA. Fixed by
  making `source` a required param on `useGenerationMix`/`GenerationMixParams` — TypeScript then
  caught every call site that needed updating, including one other real instance of the same bug
  in `RegionalMixChart`.
- `GenerationMixChart` and `DiurnalPatternChart` generalized to take `source`/`zones`/`label`
  props instead of hardcoding ONS's five subsystems, so the same components render both Brazil's
  and USA's charts — no duplicated per-country chart files.
- A new `UsaSection` (mirrors `BrazilSection` minus the map/regional-mix, which need the deferred
  balancing-authority ingestion below) with its own current-share number, generation-mix chart, and
  diurnal-pattern chart, all real EIA/US48 data.
- A shared cross-chart metric filter (`MetricFilterControl` + `DashboardShell`, which now owns the
  `visibleMetrics` state via plain `useState` per CLAUDE.md's state-management ladder — this
  changes only on a click, not every tick, so it doesn't earn a Zustand store) — toggling hides/
  shows series client-side across every chart at once without refetching.
- `useFixedDateRange`, a shared hook replacing five near-identical local `useState(() => ({from,
  to}))` implementations across chart components.

**Also built (plant leaderboard + volatility):** A new `GET /generation-top-assets` endpoint
(`packages/contracts/src/api.ts`, `apps/api/src/routes/generation-top-assets.ts`) ranks individual
real ONS plants by average output for one fuel type over a window — the plant-level granularity
(`readings.asset_id`) the pipeline already ingests but every other endpoint aggregates away.
ONS-only by design: EIA/ENTSO-E readings don't carry individual-plant granularity, only
respondent/zone-level. Queries the raw `readings` hypertable directly (not the zone-level
`generation_hourly` continuous aggregate). Verified live: top hydro plant is `PRIT60` (Itaipu-scale
output), top wind plants all cluster in `BR-NE`, matching `RegionalMixChart`'s own finding that the
Northeast is the wind-heavy subsystem. `PlantLeaderboard` (Brazil-only, per-fuel-type tabs) and
`VolatilityChart` (coefficient of variation of real hourly output per fuel type, computed
client-side from the same hourly `generation-mix` data the diurnal chart already fetches — no new
endpoint needed) are wired into both `BrazilSection` and `UsaSection`.

**Explicitly deferred (bigger, separate scope — not started this session):** EIA balancing-
authority-level generation (CISO/ERCOT/PJM/MISO/SWPP/...) for a true US-regional mix comparison
mirroring Brazil's 5 subsystems (also needed for a real US-regional map, since EIA-860's own
per-plant technology field only gives a fuel type, not a demand-side breakdown); ONS
reservoir-level (EAR) and marginal-cost (CMO) ingestion; ENTSO-E load/cross-border-flow document
types (blocked on the same missing API token as the rest of ENTSO-E); Brazil per-plant
leaderboard/volatility/ramp-rate statistics; a pipeline-transparency panel (data provenance,
ingestion throughput, DLQ viewer). Each is real, additive, and intended for a following session —
recorded here so the next session (or continuation) doesn't have to re-derive the plan or
re-verify the EIA-860 route from scratch.

## 3. Why

- A separate `live` group lets browser delivery move independently from idempotent persistence;
  slow or disconnected clients cannot hold back the durable `persist` group.
- Co-locating the `live` consumer with Fastify gives it direct access to connected sockets without
  introducing unplanned Redis/pub-sub infrastructure. Persistence remains independently scalable.
- Continuous aggregates keep chart payloads bounded and move repeated time bucketing into
  TimescaleDB, while source/unit grouping and no gap filling preserve the meaning of real readings.
- A dimensionless, within-source hydro + wind + solar share is an honest v1 cross-source comparison
  while ONS, ENTSO-E, and EIA use MWmed, MAW, and MWh respectively; calling the lossy canonical
  buckets total renewable share would not be honest.
- Explicit missing/stale/error states make the dashboard a truthful case study of both public-data
  limitations and pipeline reliability instead of a demo that looks complete by fabricating gaps.
- Official Next.js, AlignUI, and shadcn generators keep the new app aligned with current tool output
  and the repository's established workflow.

## 4. Affected files

Planned new files (exact generator output may add standard framework files; record the final list in
this section after scaffolding):

```text
apps/consumer/migrations/0002_generation_hourly.sql
apps/api/src/live/consumer.ts
apps/api/src/live/hub.ts
apps/api/src/live/types.ts
apps/api/src/routes/generation-mix.ts
apps/api/src/routes/generation-latest.ts
apps/api/src/routes/generation-share.ts
apps/api/src/routes/live.ts
apps/api/src/routes/generation-mix.spec.ts
apps/api/src/routes/generation-latest.spec.ts
apps/api/src/routes/generation-share.spec.ts
apps/api/src/live/hub.spec.ts
apps/api/src/live/live.integration.spec.ts
apps/api/src/cors.spec.ts
apps/ingest/main_test.go
apps/web/                         (created by the official Next.js generator)
```

Planned modified files:

```text
packages/contracts/src/api.ts
packages/contracts/src/api.spec.ts
packages/contracts/src/index.ts
apps/api/src/index.ts
apps/api/package.json
apps/api/tsconfig.json            (only if generated/import boundaries require it)
apps/ingest/main.go               (increase the live-verified EIA lookback)
apps/consumer/src/db.ts           (only if migration ordering needs a change)
apps/consumer/package.json        (only if migration/test scripts need a change)
packages/config/                  (Next.js-specific shared config only if required)
pnpm-lock.yaml
pnpm-workspace.yaml               (only if the generator changes workspace discovery)
turbo.json                        (add Next.js output paths if required)
.env.example
README.md
docs/architecture.md
docs/brand.md
docs/tasks/TASK-live-dashboard.md (keep decisions and final file list current)
```

Map-specific data/config files remain conditional on the ONS coordinate-source verification. Do not
create a hand-authored plant-coordinate file as a substitute.

## 5. Verification

Verification is complete only when all applicable checks below have observed results recorded in a
new `## 6. Verification results` section of this document.

1. **Contracts and static checks**
   - `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass across the monorepo.
   - `go test ./...`, `go vet ./...`, and `go build ./...` pass in `apps/ingest`, even though Phase
     4 should not alter Go code.
   - Contract tests reject unknown units, invalid date ranges, out-of-range bucket requests,
     malformed WebSocket frames, and shares outside `[0, 1]`. Route integration tests
     additionally prove that a source-scoped calculation never combines rows with unlike units.
   - `go test ./...` includes an assertion that EIA requests cover the documented five-day overlap,
     rather than the known-insufficient two-hour window.
2. **Real TimescaleDB integration**
   - Run migration `0002` against a real TimescaleDB testcontainer and confirm the continuous
     aggregate exists and refreshes.
   - Insert canonical events copied from real captured ONS/EIA responses, refresh the aggregate,
     and assert exact hourly sums, daily rollups, included-metric numerator/denominator, source unit, and
     observed interval count.
   - Leave a time bucket absent and assert all historical endpoints omit it; no generated zero or
     carry-forward row appears.
   - Replay the same captured events and confirm both raw-row count and aggregate results remain
     unchanged.
3. **Real Redpanda + WebSocket integration**
   - Against a real Redpanda testcontainer, connect a real WebSocket client to Fastify, publish a
     canonical captured reading to `readings`, and assert exactly one matching `reading` frame is
     received from group `live`.
   - Confirm the same event is persisted by group `persist` independently and remains available
     through REST after the WebSocket client disconnects/reconnects.
   - Confirm both a fresh `live` group and an existing group with committed lag consume without
     broadcasting the existing 366k-style backlog to a newly connected browser.
   - Start a second API replica in a negative/manual architecture check and confirm why the shared
     Kafka group partitions the stream between replicas; keep supported deployment verification
     pinned to one API replica and record the limitation rather than claiming horizontal fan-out.
   - Exercise a non-reading/slow socket until the configured send bound is crossed; confirm that
     client is closed while another healthy client continues receiving events and `persist` lag
     does not increase because of the slow browser.
   - Do not use the intermittently hanging Kafka admin-client path as the sole automated proof of
     lag/DLQ behavior; verify those numbers manually against `infra/docker-compose.yml` as required
     by `docs/tasks/TASK-reliability-layer.md` §6.
4. **Dashboard acceptance flow against the real local stack**
   - Start TimescaleDB/Redpanda, `persist`, API+`live`, ingest, and `apps/web` using the README's
     documented commands.
   - In a real browser, confirm the Brazil chart and map/current panel render only rows returned by
     the API, retain the `MWmed` unit label, and update after a newly published real ONS event.
   - Confirm Brazil/USA small multiples use real ONS/EIA rows and display the exact “hydro + wind +
     solar share” label. Confirm Norway either uses
     live-verified ENTSO-E rows or visibly says no verified readings exist; no placeholder line is
     drawn.
   - Confirm the USA panel receives rows newer than the former two-hour EIA window would have
     captured, or visibly reports missing/stale data if the live API still has not published them.
   - Stop the API or sever the WebSocket and confirm the pulse becomes stale after the documented
     timeout while the last real reading timestamp remains unchanged. Restart it and confirm the
     client reconnects, refreshes REST snapshots, and resumes live frames without duplicates.
   - Publish one malformed event alongside a valid real event. Confirm the valid event reaches the
     dashboard, the malformed event does not, and exactly the expected DLQ entry is visible through
     `pnpm --filter consumer dlq -- list`.
   - Confirm the pipeline-health panel matches a direct `curl /pipeline-health` response and manual
     Redpanda/TimescaleDB inspection for DLQ depth, lag, and last poll timestamps.
5. **Visual and accessibility checks**
   - Record the AlignUI CLI accent selected and the dataviz contrast validator result in
     `docs/brand.md`.
   - Check the dashboard at mobile, tablet, and desktop widths; charts remain legible and the
     pipeline-health panel remains visible.
   - Keyboard navigation reaches interactive controls/map alternatives; charts expose text
     summaries/tooltips; color is not the only carrier of metric or status meaning.
   - With reduced motion enabled, disable the pulse animation while preserving the live/stale text
     state.
   - From the generated web app's local origin, verify allowed REST requests and WebSocket upgrades
     succeed, while an unlisted Origin is rejected for both paths.

No Phase 4 code should be committed until these checks pass and the repository docs/configuration
listed in §2.6 are updated. Do not add a `Co-Authored-By` trailer.
