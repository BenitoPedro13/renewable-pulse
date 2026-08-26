# TASK-entsoe-eia-pollers

## 1. Current scenario

Phase 1 (spine) and Phase 2 (reliability) are done and committed (`6fb44c7`, `17a765c`):
`apps/ingest` has one poller (ONS Brazil), publishing to Redpanda's `readings` topic; `apps/consumer`
persists idempotently and routes bad events to `readings.dlq`; `apps/api` exposes `/readings` and
`/pipeline-health`. `packages/contracts`' `sourceSchema`/`zoneSchema`/`metricSchema`/`unitSchema` are
all closed enums scoped to what ONS actually produces (`docs/architecture.md` §3).

This is Phase 3 (`docs/tasks/TASK-implementation-plan.md` §2): add ENTSO-E (Norway) and EIA (USA)
pollers on the same canonical schema and publish path, resolving the Iceland question (already done,
see below) and the two remaining `[VERIFY]`s in `docs/architecture.md` §3.

**Credentials status (checked with the user before starting):** neither an ENTSO-E API token nor an
EIA API key exists yet. ENTSO-E's token requires emailing `transparency@entsoe.eu` (~3 business days);
EIA's is instant self-serve at `eia.gov/opendata`. Decision: build both pollers now against the
request/response shapes resolved below, with normalization logic covered by unit tests using
realistic fixture data (mirroring `ons/normalize_test.go`'s approach — that file is itself a pure
unit test, not a live-network test). A **live verification pass against real captured responses is
still owed** once the user has both credentials — tracked as an open item in §5, not silently
skipped.

### Iceland — already resolved, not part of this task

`docs/architecture.md` §3/§10 already records this (2026-08-26, during Phase 1): Iceland has no
discoverable public open-data API, ships as a static annual figure in Phase 4's dashboard. Nothing
to do here.

### `[VERIFY]` #1 — ENTSO-E RESTful API request/response shape — resolved

Official doc pages (`transparency.entsoe.eu/.../Guide.html`, the EIA-equivalent, and the Postman
collection) were unreachable when fetched today (400/503). Resolved instead by cross-referencing
`entsoe-py` (`EnergieID/entsoe-py`, a widely-used, actively-maintained open-source client that talks
to the real production API) — its actual request-building and XML-parsing code, not a hand-built
mock, per this project's "real captured response" testing ethos:

- **Base URL:** `https://web-api.tp.entsoe.eu/api`
- **Auth:** `securityToken` query parameter (not a header).
- **Request for actual generation per type:** `documentType=A75` (Actual generation per type),
  `processType=A16` (Realised), `in_Domain={EIC area code}`, `periodStart`/`periodEnd` as
  `YYYYMMDDHHmm` (UTC), e.g. `202608260000`.
- **Norway bidding-zone EIC codes** (confirmed against `entsoe-py`'s `mappings.py`):
  `NO1`→`10YNO-1--------2`, `NO2`→`10YNO-2--------T`, `NO3`→`10YNO-3--------J`,
  `NO4`→`10YNO-4--------9`, `NO5`→`10Y1001A1001A48H`.
- **Response:** XML `GL_MarketDocument` (or `Acknowledgement_MarketDocument` with a `Reason/text` on
  error/no-data — the poller must detect this root element and surface it as an error rather than
  trying to parse it as data). Each `TimeSeries` carries `MktPSRType/psrType` (fuel type code),
  `inBiddingZone_Domain.mRID` (generation direction) vs. `outBiddingZone_Domain.mRID` (consumption
  direction — e.g. pumped-storage charging; **skip these**, they are not generation), and one or more
  `Period` blocks, each with `timeInterval/start`+`end`, `resolution` (`PT60M` for this document type
  in practice), and `Point` elements (`position` + `quantity`). A point's timestamp is
  `periodStart + (position-1) × resolution`. The unit is `MAW` (megawatt) — the `quantity_Measure_Unit.name`
  tag, distinct from a period total.
- **`psrType` → canonical `metric` mapping used** (full code table from `entsoe-py`'s
  `PSRTYPE_MAPPINGS`, cross-checked against ENTSO-E's own published code list):
  `B01`–`B08` (biomass, lignite, coal-derived gas, gas, hard coal, oil, oil shale, peat) → `thermal`
  (matches ONS's existing "TÉRMICA" bucket, which already folds all combustion sources together);
  `B10`–`B12` (pumped storage, run-of-river, reservoir) → `hydro`; `B14` → `nuclear`; `B16` → `solar`;
  `B18`/`B19` (offshore/onshore) → `wind`; `B20` → `other` (new metric, see contracts change below).
  Left **unmapped on purpose** (normalize returns an error, `main.go` logs+skips, same posture as
  ONS's unmapped-`nom_tipousina` handling): `B09` geothermal, `B13` marine, `B15` other-renewable,
  `B17` waste, `B21`–`B25` (network infrastructure codes, not generation) — none of these are
  material to Norway's actual generation mix (hydro + wind dominated, no coal/nuclear/geothermal),
  so skipping is honest rather than a stopgap; extend the map if a live poll ever shows one.
- **Zones polled:** all five Norwegian bidding zones (`NO1`–`NO5`) — matches the "plant/subsystem
  granularity" precedent ONS set, and the doc's own `NO-NO1` zone-code example.

### `[VERIFY]` #2 — EIA API v2 request/response shape — resolved

`eia.gov/opendata/documentation.php` returned 503 when fetched today. Resolved via the EIA v2 API
technical documentation excerpted in `RamiKrispin/EIAapi`'s README (a real, actively-used R client for
this exact API) plus the EIA-930 program docs (PUDL's `data_sources/eia930.html`) for the
domain-specific facet/unit details:

- **Base URL / route:** `https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/`
- **Query params:** `api_key`, `frequency=hourly` (UTC hours — EIA's own docs distinguish `hourly`
  (UTC) from `local-hourly`; we use UTC to match `recorded_at`'s convention elsewhere),
  `data[0]=value`, `facets[respondent][]`, `start`/`end` as `YYYY-MM-DDTHH`, `sort[0][column]=period`,
  `sort[0][direction]=desc`, `offset`, `length` (max 5000/page).
- **Respondent scope:** `US48` (EIA's own code for "United States Lower 48" — the national
  aggregate) only, for v1. **Deviates from `docs/architecture.md` §4's illustrative `US-CAISO` zone
  example** — `CAISO` isn't EIA's actual respondent code (it's `CISO`), and a single national
  aggregate is the more direct fit for the country-comparison view (Brazil vs. Norway vs. USA
  renewable share) than one specific state ISO. `docs/architecture.md` is updated to reflect this.
  Extending to specific balancing authorities (e.g. `CISO`, `ERCO`) is a future scope increase, not
  done here.
- **`fueltype` facet codes for this route** — **superseded by live verification, see §5.1**: the EIA-930
  program docs implied a fixed 8-code set (`COL`, `NG`, `NUC`, `OIL`, `WAT`, `SUN`, `WND`, `OTH`), but
  a live poll against the real API on 2026-08-26 returned 16 distinct codes. The original 8 keep their
  mapping (`COL`/`NG`/`OIL` → `thermal`, `NUC` → `nuclear`, `WAT` → `hydro`, `SUN` → `solar`,
  `WND` → `wind`, `OTH` → `other`); the 8 discovered live are mapped in §5.1.
- **Response envelope:** `{ response: { data: [ { period, respondent, fueltype, value, ... } ] } }`.
  `period` is `YYYY-MM-DDTHH` (the UTC hour) → `recorded_at`. `value` is a numeric string; unit is
  `megawatthours` per EIA-930's own docs (an **hourly energy total, not an instantaneous/average power
  reading** — a real, documented difference from ONS's `MWmed` and ENTSO-E's `MAW`, both power units).
  Stored honestly as its own unit code `MWh` rather than silently converted — `docs/architecture.md`
  §2/§3 now flags this explicitly as a Phase 4 dashboard concern (numerically, an hourly MWh total
  and an hourly-average MW figure are the same number, but the *labels* must stay honest until that
  equivalence is deliberately confirmed and applied in the chart layer, not assumed silently in
  ingest).

## 2. Planned changes

1. **`packages/contracts/src/event.ts`**: extend `sourceSchema` to `["ONS", "ENTSOE", "EIA"]`;
   `zoneSchema` to add `NO-NO1`..`NO-NO5` and `US-US48`; `metricSchema` to add `"other"`; `unitSchema`
   to add `"MAW"` and `"MWh"`. Add acceptance tests to `event.spec.ts` for one ENTSO-E-shaped and one
   EIA-shaped reading.
2. **`apps/ingest/internal/event/event.go`**: mirror the same additions by hand (`SourceENTSOE`,
   `SourceEIA`, `MetricOther`, `UnitMAW`, `UnitMWh`) — same cross-language seam as Phase 1.
3. **`apps/ingest/internal/entsoe/`** (new package): `client.go` (HTTP GET against the confirmed URL/
   params, XML decode, `Acknowledgement_MarketDocument` error detection), `normalize.go` (`psrType` →
   metric map, direction filtering, position→timestamp math, `Normalize` returning `event.Reading`),
   unit tests mirroring `ons/normalize_test.go`'s style (construct a `TimeSeries`/`Period`/`Point`
   fixture in-memory, assert the normalized reading).
4. **`apps/ingest/internal/eia/`** (new package): `client.go` (HTTP GET, JSON decode into the response
   envelope), `normalize.go` (`fueltype` → metric map, `Normalize`), unit tests same style.
5. **`apps/ingest/main.go`**: generalize from one hardcoded ONS poller to a small list of named
   pollers, each gated on its own required env var being present (`ENTSOE_API_TOKEN`,
   `EIA_API_KEY`) — so local dev / CI keeps working with ONS alone while the user's credentials are
   pending, rather than failing outright. All pollers still share one `POLL_INTERVAL` ticker (each
   poller's own fetch window is what matters for freshness, not the trigger cadence — no need for
   per-source intervals at this scope).
6. **`.env.example`**: add `ENTSOE_API_TOKEN` and `EIA_API_KEY` (both optional/commented — absence
   disables that poller, per #5).
7. **`docs/architecture.md`**: mark both `[VERIFY]`s in §3 resolved with the findings above; update
   the illustrative `US-CAISO` zone example to `US-US48`; add the MWh-vs-MW honesty note to §2/§3;
   update §9 if needed.
8. **`README.md`**: status line/quickstart update once Phase 3 is committed.

## 3. Why

Same reasoning as Phase 1/2: real sources, canonical schema, DLQ-safe unmapped-category handling.
Gating each new poller on its own credential env var (rather than requiring both up front) means the
existing ONS spine keeps running for the user today, and Phase 3 doesn't block on a 3-business-day
external email round-trip.

## 4. Affected files

- `packages/contracts/src/event.ts`, `event.spec.ts`
- `apps/ingest/internal/event/event.go`
- `apps/ingest/internal/entsoe/client.go`, `normalize.go`, `parse.go` (XML types), `*_test.go`
- `apps/ingest/internal/eia/client.go`, `normalize.go`, `*_test.go`
- `apps/ingest/main.go`
- `.env.example`, `docs/architecture.md`, `README.md`

## 5. Verification

- `pnpm turbo run lint typecheck test build` passes across the monorepo (contracts enum extensions,
  new Go packages' unit tests).
- `go test ./...` in `apps/ingest` passes, including new `entsoe`/`eia` normalize tests built from
  realistic fixtures matching the confirmed request/response shapes above.
- ONS's existing poller and tests are unaffected (no changes to `internal/ons`).
- **Still open**: ENTSO-E live verification, blocked on the API token (requested 2026-08-26 via email
  to `transparency@entsoe.eu`, ~3 business day turnaround). Follow-up once the token arrives.

### 5.1 EIA live verification — done 2026-08-26

The user registered for an EIA key (`eia.gov/opendata`, instant) and it was used to hit the real
`fuel-type-data` endpoint. Two findings, both from actual API responses, not assumption:

1. **The endpoint works as documented in §1** — a 5-day window against `US48` returned 1728 rows
   with the expected envelope shape (`response.data[]` with `period`/`respondent`/`fueltype`/`value`).
   A window narrower than ~1 day returned 0 rows — EIA-930 hourly data has a reporting lag of roughly
   a day; not a bug, just means `eiaLookback` (currently 2h in `main.go`) will often see a thin or
   empty window in production. Left as-is for this task (doesn't fail or duplicate, just yields fewer
   rows than expected) — worth revisiting if Phase 4's dashboard needs fresher EIA data than that
   lookback reliably delivers.
2. **The `fueltype` facet has 16 codes, not the 8 assumed in §1**, confirmed against EIA's own facet
   metadata endpoint (`GET .../fuel-type-data/facet/fueltype/`, which returns authoritative
   `{id, name}` labels — not inferred from generation values). The 8 new ones and their mapping:

   | Code | EIA's label | → canonical `metric` | Reasoning |
   |---|---|---|---|
   | `PS` | Pumped Storage | `hydro` | Turbine-driven hydro generation; EIA buckets it apart from `WAT` for its dual generation/pumping accounting, but the physical generation is hydro. |
   | `SNB` | Solar with integrated battery storage | `solar` | Generation is solar-sourced; the battery is co-located storage, not a separate generation source. |
   | `WNB` | Wind with integrated battery storage | `wind` | Same reasoning as `SNB`, for wind. |
   | `BAT` | Battery / Battery storage | `other` | Standalone storage discharge, not tied to one generation source. |
   | `OES` | Other energy storage | `other` | Same as `BAT`. |
   | `UES` | Unknown/unknown energy storage | `other` | Same as `BAT`. |
   | `UNK` | Unknown | `other` | No claim possible about generation source. |
   | `GEO` | Geothermal | `other` | Doesn't fit any of the five named categories; falls to the same bucket ENTSO-E's `B09` geothermal would if it appeared (see §1's ENTSO-E table). |

   Before this fix, every `BAT`/`GEO`/`OES`/`PS`/`SNB`/`UES`/`UNK`/`WNB` row was silently skipped
   (`Normalize` returning "unmapped fueltype", logged and dropped by `main.go`) on every single poll —
   not a DLQ case (these never left the ingest process to reach Redpanda), but a real, permanent gap
   in what fraction of US48's actual generation the pipeline captured. Fixed in
   `apps/ingest/internal/eia/normalize.go`'s `metricByFuelType` map; `normalize_test.go` extended to
   cover all 16 codes.

### 5.2 Netherlands ENTSO-E bidding zone — added 2026-08-26

Added `NL` (EIC `10YNL----------L`) to `apps/ingest/internal/entsoe/client.go`'s `Zones` list and
`packages/contracts/src/event.ts`'s `zoneSchema`, per user request. Confirmed against the same
source the five Norway zones were already verified against (`entsoe-py`'s `mappings.py`), not
invented — cross-checked that entsoe-py's Norway entries match this repo's existing EIC codes
exactly before trusting its Netherlands entry. No new `psrType`/metric mapping was needed: the
existing table in §1 above is generic per-fuel-type, not Norway-specific.

**Still blocked on the same open item as the rest of ENTSO-E**: this makes the poller *ready* to
cover the Netherlands the moment `ENTSOE_API_TOKEN` exists, but cannot be live-verified until then
— the hard constraint (no synthetic data) means `apps/web`'s dashboard correctly shows no ENTSO-E
readings for either country in the meantime.

On the dashboard: `GET /generation-share` is scoped per `source`, not per `zone`, so Norway and the
Netherlands both feed the same `ENTSOE` bucket (`apps/web/src/components/dashboard/
country-comparison-section.tsx` labels it "Europe (Norway + Netherlands)" rather than implying a
single country). Splitting this into separate per-country panels — a real `generation-share`
API change to group by zone as well as source — is deliberately deferred until ENTSO-E access
actually exists (user decision, 2026-08-26): no reason to design that contract before there's real
data to distinguish.
