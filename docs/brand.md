# Brand & Visual Identity — Renewable Pulse

> Status: **built.** Originally written before any UI existed; sections below now record the
> resolved choices (AlignUI Orange primary, categorical chart palette, tabular numerals, actual
> map/leaderboard scope) alongside the original spec, so this stays the single source of truth
> rather than drifting out of sync with `apps/web`.

## 1. Identity and tone

**Working name:** Renewable Pulse. ("Pulse" carries the double meaning intended here: the
heartbeat of a live data feed, and the literal pulse of electricity moving through a grid.)
Rename freely — nothing downstream depends on the name except the repo directory itself.

**One-line pitch:** a live instrument panel for how much of the world's electricity already
comes from renewables — starting with Brazil's hydro-heavy grid, compared against a few
countries that are already almost entirely renewable.

**Tone:** factual and slightly technical, not activist. The interesting thing here is real
numbers and real engineering (see `docs/architecture.md` §2 on being honest about "real-time"),
not persuasion. Copy should read like an instrument panel's labels, not a manifesto — closer to
a Bloomberg terminal or a grid operator's own dashboard than a climate-advocacy microsite.

**Relationship to Flora:** this project is deliberately visually related to
[Flora](../../flora) — same design system, same neutral palette and type scale, so the two read
as a connected pair of the user's projects — but with its own primary accent (§2) so it doesn't
read as a reskin of the same app.

## 2. Color system

Renewable Pulse reuses **AlignUI on Tailwind v4**, byte-for-byte the same raw color ramps
Flora already uses (`apps/web/app/globals.css` §"AlignUI Raw Colors") — same neutrals
(Slate), same semantic tokens (`--color-success-*`, `--color-error-*`, etc.), same shadow and
radius systems. The only deliberate deviation is the **primary accent**.

- **Flora's primary** is green (`--color-primary-* → var(--color-green-*)`) — land, growth,
  farming.
- **Renewable Pulse's primary is amber-toned orange** (`--color-primary-* → var(--color-orange-*)`)
  — electricity, energy, a live "pulse" rather than a growing field.

  **Resolved 2026-08-26, confirmed by reading `@alignui/cli@0.0.19`'s own bundled source
  directly** (`dist/index.js`'s primary-color prompt): the CLI's real option list is exactly
  **Blue, Purple, Orange, Green** — no Yellow/Sky, matching what `TASK-live-dashboard.md` §2.4
  already recorded and superseding this section's original yellow-ramp plan. **Orange** was run
  as `primaryColor` directly (not applied as a post-hoc override), so `apps/web/src/app/globals.css`
  already defines `--color-primary-* → var(--color-orange-*)` for both light and dark mode —
  there is no separate override block to hand-write, unlike Flora's green swap. Full answers:
  primary **Orange** · neutral **Slate** · format **oklch** · prefix *(blank)* · tailwind.config
  **No — CSS-only** · global CSS `apps/web/src/app/globals.css`.

- **Energy-source categorical palette** (for stacked bars / donut charts breaking generation
  down by source) reuses AlignUI's existing semantic-adjacent ramps rather than inventing new
  hex values, per Flora's own invariant ("no raw hex outside `globals.css`, `charts/config.ts`,
  `map/config.ts`"):
  - Hydro → **blue** (`--color-information-*` ramp / water)
  - Solar → **orange/amber** (`--color-primary-*` — same ramp as the brand accent, since solar
    is the most visually "energy"-coded source)
  - Wind → **teal** (`--color-stable-*`)
  - Thermal/fossil → **red** (`--color-error-*` — deliberately the "attention" end of the
    semantic palette, since this is the non-renewable share). **Not `--color-warning-*`**: with
    Orange as the resolved primary accent (§2), AlignUI's `--color-warning-base` *is* the same
    orange ramp as `--color-primary-base`, so pairing solar (primary) with warning (thermal)
    would make the two least-distinguishable — `error` (red) stays visually distinct from both.
  - Other/nuclear → **purple** (`--color-feature-*`)

  **Resolved (2026-08-26):** the five tokens actually wired into `apps/web/src/app/globals.css`'s
  `--chart-1..5` (feeding shadcn's `chart.tsx`) are `--color-information-base` (blue,
  `oklch(55.50% 0.2449 266.68)`), `--color-primary-base` (orange, `oklch(70.64% 0.1872 47.14)`),
  `--color-stable-base` (teal, `oklch(77.94% 0.1360 180.35)`), `--color-error-base` (red,
  `oklch(64.71% 0.2288 22.47)`), `--color-feature-base` (purple, `oklch(57.72% 0.2287 289.43)`).
  Hues are spread 267°/47°/180°/22°/289° around the wheel — well separated except thermal (red,
  22°) and solar (orange, 47°), which sit only 25° apart at similar lightness (65% vs 71%) and are
  the pair most likely to be hard to tell apart under protanopia/deuteranopia (the red–green axis).
  Mitigation already in place rather than a repaint: every chart using this palette
  (`generation-mix-chart.tsx`, `regional-mix-chart.tsx`, `diurnal-pattern-chart.tsx`) renders
  shadcn's `ChartLegendContent`, which pairs each swatch with its metric's text label, and
  `ChartTooltipContent` does the same — color is a secondary cue, not the only one, satisfying
  `CLAUDE.md`'s "color never the sole carrier of meaning" rule. No raw hex was introduced; all five
  values are existing AlignUI semantic tokens.

- Renewable-share itself (the single most important number on the dashboard) uses a
  **sequential** ramp from neutral to primary-orange, *not* a red→green diverging scale — this
  isn't a good/bad judgment, it's a proportion, and treating a 30% grid as "bad" (red) misreads
  countries that are making real progress.

## 3. Typography

Identical to Flora's AlignUI type scale (`--text-title-h1` … `--text-subheading-2xs`,
`--text-paragraph-*`) — no new sizes invented. One addition specific to this project: a
**monospace numeral treatment** for the live-updating numbers (current renewable %, last-update
timestamp, DLQ depth) so they don't visually jitter as digit widths change tick to tick — use a
`tabular-nums` font-variant-numeric on those specific values, not a different typeface.

**Resolved (2026-08-26):** `apps/web/src/app/layout.tsx` loads Inter via `next/font/google`,
matching Flora; Inter exposes tabular figures through OpenType `tnum`, so no second family was
needed. `.tabular-nums` is applied selectively (not globally) across every live-updating value
built so far: pipeline-health DLQ/lag/timestamps, the hydro+wind+solar share percentages, the live
indicator's timestamp, chart tooltips, and both plant leaderboards' rank/value columns.

## 4. Dashboard visual language

- **Brazil deep-dive / USA sections**: each has its own hydro+wind+solar share number,
  stacked-area generation-mix chart, regional-mix chart (ONS's 5 subsystems / EIA's 7 RTOs),
  diurnal-pattern chart, and volatility chart — all using the categorical palette from §2.
- **Plant map** (`react-map-gl`, mirroring Flora's Mapbox GL usage): one map, one Brazil/USA
  source toggle (`PlantMapSection`) driving both the map and an adjacent per-zone totals panel in
  lockstep — Brazil renders ANEEL SIGA registry markers (color-coded by fuel, sized by installed
  capacity), USA renders EIA Form 860/860M plant-level markers grouped from generator rows. Both
  are plant *registry* geography/capacity, never implied as live per-plant output.
- **Plant leaderboards**: `PlantLeaderboard` (Brazil-only, ONS per-plant live-output ranking by
  fuel type — the one place plant-level granularity exists) and `PlantCapacityLeaderboard` (USA,
  EIA-860 registered-capacity ranking, explicitly labeled "registered capacity, not live output" so
  it's never read as directly comparable to Brazil's live-output ranking).
- **Country-comparison view**: small multiples for Brazil/Norway/USA hydro+wind+solar share, not
  one combined chart — resist the urge to build a single busy chart. Norway shows "no verified
  readings yet" rather than sample data until ENTSO-E's live token lands.
- **Cross-chart metric filter**: one `MetricFilterControl` toggles series visibility across every
  chart at once, client-side, without refetching.
- **Pipeline health panel**: per §"Reliability patterns" in `docs/architecture.md` — DLQ depth,
  consumer lag, last-successful-poll-per-source, shown plainly (numbers + a status dot), not
  hidden in an admin-only page. Showing the pipeline's own health *is* the case study.
- **Live indicator**: a small pulsing dot (literal to the name) next to the "last updated"
  timestamp when the WebSocket connection is live vs. showing cached/stale data — this is the
  one place the "pulse" metaphor should show up visually, kept subtle (a slow opacity pulse,
  not a flashing animation).
- Charts follow shadcn/ui `chart` (Recharts v3) the same way Flora's `components/charts` does,
  reusing that composition pattern rather than introducing a second charting library.

## 5. What NOT to do

- Don't invent a new color outside the AlignUI ramps already present in Flora's `globals.css`
  plus the one primary-accent swap in §2.
- Don't use red/green as a renewable-share judgment scale (§2).
- Don't let the "live pulse" identity oversell the data's actual cadence — `docs/architecture.md`
  §2 is the honesty constraint; the visual design should not contradict it (e.g. no fake
  sub-second tickers on data that only refreshes hourly).
