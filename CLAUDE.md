# Workflow Guidelines — Renewable Pulse

> Ported from the `flora` workflow (plan before you touch anything, use official CLIs/
> generators, treat documentation as part of the deliverable), retargeted to this project.

---

## 0. Project context

The design lives in `docs/architecture.md` (system) and `docs/brand.md` (visual identity).
Read `docs/tasks/TASK-implementation-plan.md` for the phased build order before writing any
code — it is the entry point for implementation, not this file.

Renewable Pulse ingests **real, public** renewable-energy generation data (Brazil via ONS,
Norway via ENTSO-E, USA via EIA) through a high-throughput, failure-resistant pipeline, and
serves it through a live dashboard. It is a standalone companion to Flora
(`../flora`, a regenerative-farming console) — sharing Flora's AlignUI visual language and
workflow conventions, but no code.

**Hard constraint:** every reading in this system must trace back to a real API response from
ONS, ENTSO-E, or EIA. No synthetic or simulated data, anywhere, ever — decided explicitly
during planning, not a default that can be quietly relaxed for convenience (e.g. to fill a demo
gap). If a real source is unavailable for something, that gap is shown as missing, not faked.

**Status:** Phases 1–3 shipped and live-verified except ENTSO-E (code-complete, unit-tested,
live verification pending an API token — see `docs/tasks/TASK-entsoe-eia-pollers.md` §5.1).
Phase 4 (`docs/tasks/TASK-live-dashboard.md`) — the live dashboard — is in progress: the API's
generation-mix/latest/share/plants/live routes and the `apps/web` design-token setup are done;
the dashboard UI itself is not yet built.

### Stack (see `docs/architecture.md` §6 for rationale)

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Ingestion edge | **Go** — scheduled pollers, normalizes to the canonical event schema |
| Broker | **Redpanda** (Kafka-API-compatible) |
| Storage | **PostgreSQL + TimescaleDB** |
| Consumer / API | **TypeScript** (Node) |
| Web | **Next.js**, AlignUI design system (Orange primary — `docs/brand.md` §2) |
| Web server state | **TanStack Query** — all REST data fetching/caching (`/generation-mix`, `/generation-latest`, `/generation-share`, `/plants`, `/pipeline-health`) |
| Web client state | Props/lifted `useState` by default; **Zustand** only for the one justified exception — live WebSocket connection status, heartbeat freshness, in-memory reading buffer (state that changes on every tick and is read by components with no other reason to be co-located) |
| Contracts | **Zod** in `packages/contracts`, consumed by consumer/API/web; `apps/ingest` (Go) hand-mirrors the same shape — a deliberate cross-language seam, not an oversight |

Version numbers are a snapshot, not a pin — verify against each tool's own current docs before
installing.

### Frontend state conventions (apps/web)

Verified against TanStack Query's and Zustand's own current Next.js App Router guides before
adoption (Next.js's [TanStack Query guide](https://nextjs.org/docs/app/guides/client-side-data-fetching/tanstack-query),
Zustand's [Next.js guide](https://zustand.docs.pmnd.rs/learn/guides/nextjs)) — re-verify if either
guide has since changed before deviating from the patterns below.

**Default to the plainest tool that works; escalate only when it actually hurts.** Props and a
lifted `useState` handle most component state. Prop drilling and plain Context don't get messy on
their own — they get messy when the presentation layer is carrying logic it shouldn't. Keep
components thin (render + a call to an abstracted hook, per the last bullet below) and drilling a
couple of levels stays boring and easy to follow. Reach for the tools below only for the specific
things they solve, not as a default reflex:

- **Server state is TanStack Query, never `useEffect` + `useState`.** Each REST endpoint gets one
  `queryOptions(...)` factory (query key + `queryFn` defined together, so every caller shares the
  same cache identity) under `src/lib/queries/`, and exactly one custom hook under `src/hooks/`
  that calls it — e.g. `useGenerationMix(params)`, never a raw `useQuery` call inside a component.
  Provider setup follows the official `getQueryClient()` pattern: a brand-new `QueryClient` for
  every server render, one reused `QueryClient` singleton in the browser — not a plain
  `useState(() => new QueryClient())`. This one is not optional: it's a well-maintained library
  solving cache/race/retry problems correctly, which is worth more than a hand-rolled `fetch` in
  a `useEffect` that a future maintainer has to re-debug from scratch.
- **Zustand is the exception, reserved for state that changes on every tick and is read by
  components with no other reason to be co-located** — here, the live WebSocket connection
  status, heartbeat freshness, and the in-memory reading buffer. That's the actual failure mode
  prop drilling/Context can't solve well: a value ticking many times a second would otherwise
  either re-render every intermediate component (Context) or thread a prop through layers that
  don't use it. If a new piece of state doesn't have that shape, it does not get a store — lift it
  with `useState` or pass it as a prop instead. When it does: follow Zustand's Next.js guide
  exactly — `createStore` from `zustand/vanilla` under `src/stores/`, a Context provider that
  creates the store inside `useState` (never a module-level global store — that leaks state across
  requests/users on the server), and a selector-based custom hook (`useLiveConnectionStatus()`,
  `useLiveReading(key)`) — never call `useStore` on the store's context directly from a component.
- **A plain React Context is for a stable service/manager instance, not for frequently-changing
  state.** The WebSocket client itself (opens/closes/reconnects the socket, feeds the Zustand
  store) is a good Context value; the connection status it produces is not — that belongs in the
  Zustand store above so subscribing components can select just the slice they need instead of
  re-rendering on every tick. For anything that doesn't change on every tick, plain Context (or
  just props) is enough — don't add a store for it.
- **Every hook is abstracted.** `src/hooks/` (or a feature-local `hooks.ts`) is the only place
  that imports `@tanstack/react-query`, the live-client Context, or a Zustand store directly. This
  is also where the "hydro + wind + solar share, not renewable share" label, unit-preservation,
  and missing-vs-zero rules from `docs/tasks/TASK-live-dashboard.md` §2.1 live once, not
  duplicated per component. This is what keeps prop drilling and Context boring in the first
  place — the presentation layer never holds logic worth lifting into a bigger state mechanism.

### Rendering & effects conventions (apps/web)

- **Server Components by default; push `'use client'` to the leaves.** Every component under
  `apps/web/src/app/` is a Server Component unless it needs `useState`, `useEffect`, event
  handlers, or a browser API. Fetch/compose on the server and pass data down to a small client
  component that wraps only the interactive part — don't mark a whole page `'use client'` because
  one control needs an `onClick`.
- **`useEffect` is for synchronizing with an external system (a browser API, a third-party
  widget, a WebSocket/subscription) — not a general-purpose "run this after render" hook.**
  Verified against React's own current guidance,
  [react.dev/learn/you-might-not-need-an-effect](https://react.dev/learn/you-might-not-need-an-effect);
  re-check that page before deviating. Before writing a `useEffect`, check whether it's actually
  one of these:
  - **Derived from props/state?** Compute it during render — no `useState`/`useEffect` pair. Wrap
    an expensive computation in `useMemo`, not an Effect that calls `setState`.
  - **Should reset when a prop changes?** Give the component a `key` tied to that prop so React
    remounts it, instead of an Effect that manually resets state.
  - **Triggered by a user action (click, submit)?** Put it in the event handler, not an Effect —
    this is also where a POST/mutation triggered by that action belongs (via a TanStack Query
    `useMutation`, per the state conventions above).
  - **Needs to update a parent when local state changes?** Update both in the same event handler;
    don't have a child Effect call the parent's `onChange`.
  - **Actually synchronizing with something outside React** (the live WebSocket connection,
    `window`/`navigator` events, a non-React widget)? That's a real Effect — give it a cleanup
    function and, when it exposes read state to components, prefer wrapping it in
    `useSyncExternalStore` (or the Zustand store above) over exposing raw Effect-managed state.

### Restraint & accessibility conventions (apps/web)

- **YAGNI over preemptive optimization.** Don't add a hook, a store, or an abstraction for a
  requirement that doesn't exist yet. The state-management ladder above and the memoization rule
  below are both instances of this, not separate ideas.
- **`useMemo`, `useCallback`, and `React.memo` are not applied by default — only after profiling
  shows an actual re-render problem.** Wrapping every value/function "for performance" adds a
  dependency array to get wrong and rarely pays for itself; React's own guidance
  ([react.dev/learn/you-might-not-need-an-effect](https://react.dev/learn/you-might-not-need-an-effect))
  treats reflexive memoization as its own anti-pattern, not a hygiene habit. If `apps/web` enables
  the React Compiler (stable as of Next.js 16 via `reactCompiler: true` in `next.config.ts`,
  verify current status before flipping it on), it inserts this memoization automatically at
  build time — another reason not to hand-write it preemptively.
- **`useLayoutEffect` is for the rare case of reading layout and synchronously re-rendering before
  the browser paints** (measuring a DOM node, preventing visible flicker) — not a stand-in for
  `useEffect`. If nothing measures the DOM, it isn't needed.
- **Prefer a maintained, accessible library over a hand-rolled interactive widget.** A custom
  dropdown, combobox, date picker, or drag-and-drop reimplements keyboard interaction and ARIA
  state machines that the W3C's own [ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
  documents precisely because they're easy to get subtly wrong — "no ARIA is better than bad
  ARIA." A component from shadcn/ui (Radix primitives) or TanStack has many more eyes on its
  accessibility than something built from scratch for one screen, and stays maintained after this
  task is done. Reach for `docs/architecture.md`/`docs/brand.md`'s already-chosen libraries before
  building a bespoke interactive component.
- **WCAG 2.2 AA conformance is non-negotiable**, not a "nice to have" pass at the end — see
  `docs/tasks/TASK-live-dashboard.md` §5.5 for this project's concrete checklist (keyboard
  reachability, text alternatives for charts, color not the sole carrier of meaning, reduced
  motion). A native HTML element or a vetted library component gets most of this for free; that's
  the practical reason to prefer them, not just the ideological one.

### How to write in this repo

- **Never invent an API response shape, field name, or provider behavior.** Write
  `[VERIFY: what to check and where]` inline instead. `docs/architecture.md` already carries
  several (ONS dataset endpoints, ENTSO-E document types, EIA v2 request shape, Iceland's data
  source). Resolve each before the code depending on it ships.
- **Be specific to the point of discomfort**: exact endpoint paths, exact field names, exact
  poll intervals. No acceptance criterion may rest on "works" or "fast enough".

### Invariants — never break these without changing the spec first

1. **No synthetic or simulated data, anywhere.** This is the project's entire premise; see
   "Hard constraint" above.
2. **`packages/contracts` is the single source of truth for the event/API shape on the TS
   side.** `apps/ingest`'s Go structs mirror it by hand — whoever changes the schema updates
   both in the same task.
3. **Idempotent writes only.** Every write to TimescaleDB is keyed on
   `(source, zone, asset_id, metric, recorded_at)`; re-processing the same event must never
   duplicate a row.
4. **No colors outside the AlignUI ramps already defined**, plus the one primary-accent swap
   documented in `docs/brand.md` §2 (Orange instead of Flora's Green). Don't invent new hex
   values for charts or the map — reuse the existing semantic ramps per `docs/brand.md` §2.
5. **A dead-letter queue, not a dropped or crashing consumer**, is how malformed/unknown events
   are handled (`docs/architecture.md` §5).

### Tests

- **Integration tests against real infra** (testcontainers: Redpanda, TimescaleDB) — never mock
  the broker or database.
- **Idempotency is a test, not an assumption**: replay the same poll response twice, assert row
  count is unchanged.
- **DLQ routing is a test**: a malformed event inside a valid batch must land in `readings.dlq`
  without blocking the valid ones.
- **A provider's response shape is tested from a real captured response**, not a hand-built
  mock — matches this project's "real data only" ethos.

---

## 1. Plan before executing — write a task document first

**Rule:** Before editing or creating any code file, write a task document at
`docs/tasks/TASK-<slug>.md` with: Current scenario, Planned changes, Why, Affected files,
Verification (see `docs/tasks/TASK-implementation-plan.md` for the template this project
uses). Keep it in sync if the plan changes mid-task.

## 2. Use CLIs, generators, and SDKs — don't write everything by hand

Check each tool's current docs before scaffolding or adding a dependency, then use its official
CLI/generator (AlignUI's CLI for the design tokens, `pnpm create`/framework generators for
apps, `drizzle-kit generate` if Drizzle is used for the TS-side schema, etc.).

## 3. Update documentation after executing

Before considering a task done, update every doc it affects: this file (if the stack or an
invariant changes), `docs/architecture.md` (if it resolves a `[VERIFY]` or changes scope),
`docs/brand.md` (if a visual `[VERIFY]` resolves), `.env.example` (every env var the code
reads), and `README.md` (status line and quickstart).

## 4. Project conventions

```
apps/
  ingest/     Go — scheduled pollers, normalize, publish to Redpanda
  consumer/   TS — "persist" and "live" consumer groups
  api/        TS — REST + WebSocket
  web/        Next.js — dashboard
packages/
  contracts/  Zod schemas + inferred types
  config/     shared tsconfig, eslint, prettier
infra/        docker-compose — Redpanda, TimescaleDB
docs/         architecture.md, brand.md, tasks/
```

### Commit conventions

- Commit automatically once a task doc's work is complete and verified — don't wait to be asked
  for each one. Not blanket permission for destructive git operations, which still need
  explicit confirmation.
- **Never add a `Co-Authored-By` trailer to commits in this repo.**

---

## TL;DR

Plan (`docs/tasks/TASK-<slug>.md`) → align → build with official generators, real data only,
types from `packages/contracts` → update `docs/architecture.md` / `docs/brand.md` /
`.env.example` / `README.md` → commit (no `Co-Authored-By`) → done. Never broken: no synthetic
data, idempotent writes only, contracts are the single source of truth, no colors outside the
documented AlignUI ramps, malformed events go to the DLQ instead of crashing the consumer.
