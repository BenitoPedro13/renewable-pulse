import { z } from "zod";

/**
 * ONS subsystem codes (id_subsistema), prefixed to match the BR-<zone>
 * convention documented in docs/architecture.md §4. Extend with ENTSO-E/EIA
 * zone codes in Phase 3 — do not silently widen this to z.string().
 */
export const zoneSchema = z.enum(["BR-N", "BR-NE", "BR-S", "BR-SE", "BR-CO"]);
export type Zone = z.infer<typeof zoneSchema>;

/**
 * Normalized generation source, derived from ONS's nom_tipousina field.
 * Confirmed live values (2026-08-26 poll of the current-month file):
 * HIDROELÉTRICA, TÉRMICA, EOLIELÉTRICA, FOTOVOLTAICA, and NUCLEAR (Angra —
 * kept distinct from "thermal" rather than folded in, since conflating a
 * fission plant with fossil/biomass thermal would misrepresent the
 * dashboard's renewable-share story). Extend as ENTSO-E/EIA fuel-type
 * vocabularies are mapped in during Phase 3.
 */
export const metricSchema = z.enum(["hydro", "thermal", "wind", "solar", "nuclear"]);
export type Metric = z.infer<typeof metricSchema>;

/**
 * Unit is constrained to what's actually confirmed for the sources wired up
 * so far. ONS's own data dictionary (see docs/architecture.md §3) confirms
 * val_geracao is "MWmed" (average MW over the hour), not plain MW/MWh —
 * widen only once a new source's unit is verified against its own docs,
 * never assumed.
 */
export const unitSchema = z.enum(["MWmed"]);
export type Unit = z.infer<typeof unitSchema>;

export const sourceSchema = z.enum(["ONS"]);
export type Source = z.infer<typeof sourceSchema>;

/**
 * The canonical event schema (docs/architecture.md §4) — the single source
 * of truth for the reading shape on the TS side. apps/ingest (Go) mirrors
 * this by hand; whoever changes this schema must update both in the same
 * task.
 */
export const readingEventSchema = z.object({
  source: sourceSchema,
  zone: zoneSchema,
  asset_id: z.string().nullable(),
  metric: metricSchema,
  value: z.number(),
  unit: unitSchema,
  recorded_at: z.iso.datetime({ offset: true }),
  ingested_at: z.iso.datetime({ offset: true }),
  schema_version: z.literal(1),
});

export type ReadingEvent = z.infer<typeof readingEventSchema>;

/**
 * The idempotency key (docs/architecture.md §4): every write to TimescaleDB
 * is keyed on this composite tuple. Re-processing the same event must never
 * duplicate a row.
 */
export const readingIdempotencyKeyFields = [
  "source",
  "zone",
  "asset_id",
  "metric",
  "recorded_at",
] as const satisfies readonly (keyof ReadingEvent)[];
