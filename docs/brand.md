# Brand & Visual Identity — Renewable Pulse

> Status: spec only. Written before any UI exists, so the implementation session has a
> single source of truth for tone, palette, and typography instead of improvising per screen.

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
- **Renewable Pulse's primary is amber** (`--color-primary-* → var(--color-yellow-*)`) —
  electricity, energy, a live "pulse" rather than a growing field. Copy the exact override
  pattern Flora's `globals.css` uses, substituting the ramp:

  ```css
  --color-primary-dark: var(--color-yellow-800);
  --color-primary-darker: var(--color-yellow-700);
  --color-primary-base: var(--color-yellow-600);
  --color-primary-light: var(--color-yellow-100);
  --color-primary-lighter: var(--color-yellow-50);
  --color-primary-alpha-24: var(--color-yellow-alpha-24);
  --color-primary-alpha-16: var(--color-yellow-alpha-16);
  --color-primary-alpha-10: var(--color-yellow-alpha-10);
  ```

  And the dark-mode primary reassignment Flora's `@media (prefers-color-scheme: dark)` block
  does for green, mirrored for yellow (`--color-primary-light: var(--color-yellow-alpha-16)`,
  `--color-primary-lighter: var(--color-yellow-alpha-10)`).

  `[VERIFY: run AlignUI's own CLI (`npx @alignui/cli tailwind`) during implementation and pick
  its closest built-in accent name to this amber/yellow ramp, the way Flora's CLAUDE.md records
  picking "Slate" over "Gray" — don't hand-edit tokens the CLI would have generated correctly.]`

- **Energy-source categorical palette** (for stacked bars / donut charts breaking generation
  down by source) reuses AlignUI's existing semantic-adjacent ramps rather than inventing new
  hex values, per Flora's own invariant ("no raw hex outside `globals.css`, `charts/config.ts`,
  `map/config.ts`"):
  - Hydro → **blue** (`--color-information-*` ramp / water)
  - Solar → **yellow/amber** (`--color-primary-*` — same ramp as the brand accent, since solar
    is the most visually "energy"-coded source)
  - Wind → **sky/teal** (`--color-verified-*` or `--color-stable-*`)
  - Thermal/fossil → **orange/red** (`--color-warning-*` / `--color-error-*` — deliberately the
    "attention" end of the semantic palette, since this is the non-renewable share)
  - Other/nuclear → **purple** (`--color-feature-*`)

  `[VERIFY against the dataviz skill's palette-and-contrast validator before shipping real
  charts — this mapping is a starting proposal, not yet checked for pairwise contrast or
  colorblind-safety at the swatch sizes the actual charts will use.]`

- Renewable-share itself (the single most important number on the dashboard) uses a
  **sequential** ramp from neutral to primary-amber, *not* a red→green diverging scale — this
  isn't a good/bad judgment, it's a proportion, and treating a 30% grid as "bad" (red) misreads
  countries that are making real progress.

## 3. Typography

Identical to Flora's AlignUI type scale (`--text-title-h1` … `--text-subheading-2xs`,
`--text-paragraph-*`) — no new sizes invented. One addition specific to this project: a
**monospace numeral treatment** for the live-updating numbers (current renewable %, last-update
timestamp, DLQ depth) so they don't visually jitter as digit widths change tick to tick — use a
`tabular-nums` font-variant-numeric on those specific values, not a different typeface.

`[VERIFY: confirm Flora's base font (likely a variable font loaded via next/font) exposes
tabular figures; if not, pick a fallback that does rather than introducing a second family.]`

## 4. Dashboard visual language

- **Brazil deep-dive view**: a subsystem/plant map (mirrors Flora's Mapbox GL usage —
  `react-map-gl`, `mapbox-gl-draw`/`turf` if any geometry math is needed) plus a stacked-area
  chart of generation mix over time, using the categorical palette from §2.
- **Country-comparison view**: small-multiple or grouped-bar comparison of Brazil vs.
  Norway/Iceland vs. USA renewable share — resist the urge to build a single busy chart; three
  clean small multiples read faster than one overloaded one.
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
