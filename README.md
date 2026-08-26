# Renewable Pulse

A live instrument panel for how much of the world's electricity already comes from
renewables — starting with Brazil's hydro-heavy grid, compared against a few countries that
are already almost entirely renewable (Norway, Iceland) and the USA.

**Status: specs only.** Nothing is built yet. See `docs/tasks/TASK-implementation-plan.md` for
the phased build order.

## What this is

A companion project to [Flora](../flora) (a regenerative-farming console): a real-time-feeling
data platform that ingests **real, public** renewable-energy generation data through a
high-throughput, failure-resistant pipeline (Go ingestion edge → Redpanda → idempotent
TypeScript consumers → TimescaleDB → a live Next.js dashboard), and doubles as an engineering
rehearsal for the IoT/device-ingestion problem Flora's own architecture has identified and
deferred.

**Every reading in this system traces back to a real API response.** No simulated sensors, no
synthetic data — see `docs/architecture.md` §2 for an honest discussion of what "real-time"
actually means here, given the upstream sources are polled, not pushed.

## Data sources (all free, no paywall)

- **[ONS Dados Abertos](https://dados.ons.org.br)** — Brazil's grid operator: generation by
  source, reservoir levels, interchange, load, marginal cost. Plant-level granularity.
- **[ENTSO-E Transparency Platform](https://transparency.entsoe.eu)** — EU grids including
  Norway: generation by fuel type, load, cross-border flows.
- **[EIA Open Data API](https://www.eia.gov/opendata)** — USA: generation by fuel type, by
  balancing authority and state.

See `docs/architecture.md` §3 for access details and open `[VERIFY]` items.

## Docs

- `docs/architecture.md` — system design: data sources, event pipeline, reliability patterns,
  stack rationale.
- `docs/brand.md` — visual identity: shares Flora's AlignUI design system with its own amber
  primary accent.
- `docs/tasks/` — one task document per unit of implementation work, written before that work's
  code (see `CLAUDE.md`).

## Stack

Go (ingestion edge) · Redpanda · TimescaleDB · TypeScript/Node (consumers, API) · Next.js
(dashboard) · Zod (contracts) · pnpm + Turborepo. See `docs/architecture.md` §6 for the
rationale behind each choice.
