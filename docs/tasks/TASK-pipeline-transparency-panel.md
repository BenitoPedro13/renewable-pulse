# TASK-pipeline-transparency-panel

## 1. Current scenario

`docs/tasks/TASK-live-dashboard.md` §2.7 shipped v1's `PipelineHealthSection`: the three numbers
from `GET /pipeline-health` (`dlqDepth`, `consumerLag`, `lastPollBySource`), rendered plainly with
explicit "Not observed" states. It deferred a **pipeline-transparency panel** — "data provenance,
ingestion throughput, a DLQ viewer" — as bigger, separate scope. The user has now approved it as
the next priority (2026-08-26).

What already exists that this task reuses rather than rebuilds:

- **DLQ inspection** already exists as a CLI (`apps/consumer/src/dlq-cli.ts`'s `list` command): a
  throwaway consumer group reads `readings.dlq` from the beginning and parses each message with
  `dlqEventSchema` (`{ raw, error, source_topic, failed_at }`, `packages/contracts/src/dlq.ts`).
  Nothing exposes this over HTTP for the web dashboard today.
- **Ingestion throughput data already exists**, uncharted: `generation_hourly` (the continuous
  aggregate `apps/consumer/migrations/0002_generation_hourly.sql` created, grouped by
  `time_bucket('1 hour', recorded_at), source, zone, metric, unit`) already stores a real
  `reading_count` per bucket. No new migration or Go/ingest change is needed to surface "how many
  real readings landed per source per hour" — it's an aggregation query away.
- **Data provenance facts already exist**, undisplayed: `docs/architecture.md` §3 documents each
  source's real dataset name, URL, license, and refresh cadence (ONS's monthly CKAN CSV dump,
  ENTSO-E's A75/A16 document type via the `entsoe-py`-verified API, EIA's v2
  `electricity/rto/fuel-type-data` route). None of this is shown in the UI; a visitor sees numbers
  with no explanation of where they physically come from.

## 2. Planned changes

No Go code, no `packages/contracts` event-schema change, no new TimescaleDB migration. This is
additive API DTOs (`packages/contracts/src/api.ts`) + two new `apps/api` routes + new `apps/web`
components, all read-only.

### 2.1 `GET /pipeline-health/dlq` — real-time DLQ preview

- Query: `limit` (default 20, max 100, matching the existing `readings.limit` clamp pattern).
- Response: `{ entries: [{ partition, offset, raw, error, sourceTopic, failedAt }] }` — the same
  shape `dlq-cli.ts list` already prints, plus `partition`/`offset` so the web viewer can show
  exactly what the CLI would replay.
- Implementation reuses the same throwaway-consumer-group peek pattern already proven in
  `dlq-cli.ts` (`collectDlqMessages`): connect, `fetchTopicOffsets` to know how many messages
  exist, consume from the beginning up to `limit`, parse each with `dlqEventSchema`, disconnect.
  Read-only — **no replay action is exposed over HTTP**; replay stays a deliberate, operator-run
  CLI action (`pnpm --filter consumer dlq -- replay`) so a public/browser-reachable route can never
  trigger a mutating re-publish.
- Lives in `apps/api/src/routes/pipeline-health-dlq.ts`, a sibling to `pipeline-health.ts`, not a
  shared package with `apps/consumer`'s CLI — the ~30-line peek logic is small enough that
  duplicating it across the two already-separate deployables is simpler than introducing a new
  shared internal package for one function, consistent with this repo's existing Go/TS "mirror by
  hand" precedent for small cross-boundary logic.

### 2.2 `GET /ingestion-throughput` — real hourly reading counts per source

- Query: reuses the existing `dateRangeSchema` (`from`/`to`) plus the existing
  `maxRange(MAX_HOURLY_DAYS)` guard already defined in `api.ts` for `/generation-mix`'s hour
  bucket — no new range-validation logic invented.
- Response: `{ rows: [{ bucketStart, source, readingCount }] }` — `SUM(reading_count) FROM
  generation_hourly WHERE recorded_at... GROUP BY bucket_start, source`, deliberately dropping
  `zone`/`metric`/`unit` from the grouping (throughput is a volume question, not a value question,
  so no unit-mixing concern applies here — we're summing counts, not the differently-united
  `value` column).
- An hour with zero real readings for a source is simply absent from the rows for that
  source/hour, not a generated zero — same missing-data convention as every other endpoint.

### 2.3 Data provenance — static, not a new endpoint

The per-source facts (dataset name, URL, license, refresh cadence) are fixed, already-verified
real facts, not something that changes per request or needs a database round trip. Deliberately
**not** a new API route + schema — that would be inventing request/response ceremony around
static text. Instead: a typed constant array in
`apps/web/src/components/dashboard/data-provenance.tsx`, sourced directly from
`docs/architecture.md` §3's already-verified facts (ONS's `dados.ons.org.br/dataset/geracao-usina-2`
CKAN resource, cadence "daily at 12:00/19:00"; ENTSO-E's Transparency Platform, A75/A16, 15–60 min
resolution, pending live token; EIA's `api.eia.gov/v2/electricity/rto/fuel-type-data`, hourly). No
fact here is invented; each line cites the section of `docs/architecture.md` it was verified in.

### 2.4 Web: `PipelineTransparencySection`

A new section (`apps/web/src/components/dashboard/pipeline-transparency-section.tsx`), separate
from the existing `PipelineHealthSection` (which keeps just the three headline numbers), composed
of:

- `IngestionThroughputChart` — a shadcn `chart` stacked/grouped bar (Recharts v3, matching every
  other chart in the app), one series per source, over the last 7 days of real hourly
  `reading_count`s. Uses the existing categorical-adjacent source coloring convention (ONS/EIA/
  ENTSO-E get distinct chart colors — reusing `--chart-*` tokens already defined, no new hex).
- `DlqPreview` — a table/list of the real entries from §2.1: `failedAt` (tabular-nums timestamp),
  `sourceTopic`, `error`, and the raw payload in a `<details>`/collapsible so a long raw JSON blob
  doesn't dominate the layout. Empty state reads "readings.dlq is empty" (mirroring the CLI's own
  message) rather than a blank list with no explanation.
- `DataProvenance` — the static cards from §2.3, one per source, each with a real outbound link to
  the dataset/API page.

Every new hook (`use-ingestion-throughput.ts`, `use-pipeline-dlq.ts`) follows the existing
`queryOptions` factory + one-hook-per-endpoint convention (`src/lib/queries/*.ts` +
`src/hooks/*.ts`) already used by every other REST endpoint in this app — no inline `useQuery`.

`app/page.tsx` mounts `PipelineTransparencySection` directly below the existing
`PipelineHealthSection`, both still visible on the main dashboard (not an admin-only route), per
`docs/brand.md` §4's "showing the pipeline's own health *is* the case study."

## 3. Why

- The pipeline's actual reliability engineering (idempotency, DLQ routing, bounded backpressure,
  a real continuous aggregate) is the differentiated part of this project per
  `docs/architecture.md` §1/§5, but v1's dashboard only showed three summary numbers. Making the
  DLQ and throughput genuinely visible — not just their headline counts — is what turns "pipeline
  health" from a stat into a case study a visitor can actually inspect.
- Reusing `generation_hourly` for throughput and the existing DLQ-peek pattern for the viewer means
  zero new migrations, zero new Go/ingest changes, and no new mutating surface — the feature is
  additive read-only API + UI only, keeping blast radius small for a panel whose only job is
  transparency.
- Keeping DLQ replay CLI-only (not exposed over HTTP) avoids turning a public-reachable dashboard
  route into an accidental mutation endpoint.

## 4. Affected files

New:
```text
apps/api/src/routes/pipeline-health-dlq.ts
apps/api/src/routes/pipeline-health-dlq.spec.ts
apps/api/src/routes/ingestion-throughput.ts
apps/api/src/routes/ingestion-throughput.spec.ts
apps/web/src/lib/queries/pipeline-dlq.ts
apps/web/src/lib/queries/ingestion-throughput.ts
apps/web/src/hooks/use-pipeline-dlq.ts
apps/web/src/hooks/use-ingestion-throughput.ts
apps/web/src/components/dashboard/pipeline-transparency-section.tsx
apps/web/src/components/dashboard/ingestion-throughput-chart.tsx
apps/web/src/components/dashboard/dlq-preview.tsx
apps/web/src/components/dashboard/data-provenance.tsx
```

Modified:
```text
packages/contracts/src/api.ts        (dlqPreview*, ingestionThroughput* schemas)
packages/contracts/src/api.spec.ts
packages/contracts/src/index.ts      (re-export, if not already a wildcard)
apps/api/src/index.ts                (register the two new routes)
apps/web/src/components/dashboard/dashboard-shell.tsx (mounts PipelineTransparencySection; page.tsx
                                       renders DashboardShell and doesn't compose sections directly)
docs/architecture.md                 (§4.1 API surface list, after implementation)
docs/tasks/TASK-live-dashboard.md    (§2.7's "explicitly deferred" note resolved)
```

## 5. Verification

1. **Contracts and static checks**: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
   New Zod schemas reject a limit over 100, a range wider than the documented maximum, and a
   malformed DLQ entry shape.
2. **Real Redpanda integration** (`pipeline-health-dlq.spec.ts`): publish one real malformed event
   (reusing the same malformed-event fixture shape `batch.spec.ts` already uses — an invalid zone)
   through `apps/consumer`'s real `processBatch` so it lands in a real `readings.dlq` via the
   actual DLQ-routing path (not a hand-inserted fixture), then confirm the new route returns it
   with the correct `sourceTopic`/`error`/`raw`, and that a `limit` smaller than the queue depth
   returns exactly that many messages.
3. **Real TimescaleDB integration** (`ingestion-throughput.spec.ts`): same real-migration-runner
   pattern as `generation-mix.spec.ts` — insert real-shaped canonical events across two sources and
   two hours, refresh `generation_hourly`, assert summed `readingCount` per source/hour and that an
   hour with no rows for a source is simply absent.
4. **Dashboard acceptance**: against the real running stack, confirm the transparency panel renders
   real throughput bars matching a direct `generation_hourly` query, confirm the DLQ preview
   matches `pnpm --filter consumer dlq -- list`'s own output for the same topic state, and confirm
   each provenance card's link resolves to the real dataset/API page it names.
5. **Accessibility**: DLQ raw-payload `<details>` is keyboard-operable; the throughput chart's
   legend pairs each source with a text label (not color alone); provenance links have real
   discernible link text, not "click here".

No code should be committed until these checks pass; update `docs/architecture.md` and
`TASK-live-dashboard.md` per §4 after implementation, per `CLAUDE.md` §3.

## 6. Verification results (2026-08-26/27)

1. **Contracts and static checks — pass.** `pnpm build`, `pnpm lint`, `pnpm test` (monorepo-wide,
   real Redpanda/TimescaleDB testcontainers) all green: `pipeline-health-dlq.spec.ts` (3/3, real
   Redpanda), `ingestion-throughput.spec.ts` (3/3, real TimescaleDB), plus the two new
   `api.spec.ts` cases — 12 API test files / 51 tests total, none failing. `apps/web`'s `next build`
   compiles and passes its TypeScript check; `pnpm --filter web lint` is clean.
2. **Real Redpanda/TimescaleDB integration — pass**, per §5.2/§5.3 above.
3. **Live verification against a real running stack — pass, and it surfaced a real operational
   bug.** A peer dev session's `apps/api` (tsx watch, port 3011) picked up both new routes without
   a restart (routes are plain modules, unlike the `packages/contracts` zone-enum case that needed
   one in §2.9 of `TASK-live-dashboard.md`). Live `curl` confirmed:
   - `GET /ingestion-throughput?from=...&to=...` returns real per-source hourly counts (e.g. ONS:
     637 readings/hour, EIA: 48 readings/hour, matching that session's actual poll cadence) and
     correctly 400s when `from`/`to` are missing.
   - `GET /pipeline-health/dlq?limit=3` returns real DLQ entries — and in doing so **surfaced a
     live instance of the exact stale-process bug `TASK-live-dashboard.md` §2.9 already
     diagnosed**: that peer session's `apps/consumer` "persist" process predates the §2.8 RTO zone
     additions, so it's currently rejecting real `US-CISO` EIA RTO readings as
     `zone: invalid_value` and routing them to `readings.dlq` (`dlqDepth` was 6064 at check time).
     This is someone else's live dev session, not one this task started, so it was not restarted
     here — flagged to the user instead of acted on unilaterally. This is exactly the kind of real
     problem the transparency panel is meant to make visible instead of hiding.
4. **Accessibility** — `IngestionThroughputChart` renders both `ChartTooltipContent` and a real
   `ChartLegendContent` (the gap noted as a `[VERIFY]` follow-up for the *existing* charts in
   `docs/brand.md` §2 during the prior doc-closeout pass does not apply to this new chart — it was
   built with a persistent legend from the start). `DlqPreview`'s raw-payload disclosure uses a
   native `<details>/<summary>`, keyboard-operable with no custom JS. `DataProvenance` links carry
   real descriptive text (the dataset name), not "click here".

**Not re-verified in this pass:** mobile/tablet/desktop responsive widths for the new section
specifically (relies on the same AlignUI layout primitives every other section already uses, per
prior sessions' responsive verification).
