import { z } from "zod";

/**
 * ONS subsystem codes (BR-<id_subsistema>), ENTSO-E bidding zones (Norway's
 * five NO-NO1..NO-NO5 plus the Netherlands' single NL bidding zone — EIC
 * `10YNL----------L`, confirmed against entsoe-py's own mappings.py, the
 * same trusted source the Norway zones were verified against), and EIA's
 * US48 national aggregate (docs/architecture.md §3, Phase 3) — do not
 * silently widen this to z.string().
 */
export const zoneSchema = z.enum([
  "BR-N",
  "BR-NE",
  "BR-S",
  "BR-SE",
  "BR-CO",
  "NO-NO1",
  "NO-NO2",
  "NO-NO3",
  "NO-NO4",
  "NO-NO5",
  "NL",
  "US-US48",
]);
export type Zone = z.infer<typeof zoneSchema>;

/**
 * Normalized generation source. ONS's nom_tipousina values map 1:1
 * (HIDROELÉTRICA, TÉRMICA, EOLIELÉTRICA, FOTOVOLTAICA, NUCLEAR — nuclear
 * kept distinct from "thermal" rather than folded in, since conflating a
 * fission plant with fossil/biomass thermal would misrepresent the
 * dashboard's renewable-share story). ENTSO-E's psrType and EIA's fueltype
 * vocabularies (docs/architecture.md §3, Phase 3) fold their combustion
 * categories (biomass/coal/gas/oil/peat) into the same "thermal" bucket, and
 * both add an "other" catch-all for categories that don't fit hydro/thermal/
 * wind/solar/nuclear (ENTSO-E's B20, EIA's OTH).
 */
export const metricSchema = z.enum(["hydro", "thermal", "wind", "solar", "nuclear", "other"]);
export type Metric = z.infer<typeof metricSchema>;

/**
 * Unit is constrained to what's actually confirmed for the sources wired up
 * so far, never assumed. ONS: "MWmed" (average MW over the hour, its own
 * data dictionary — docs/architecture.md §3). ENTSO-E: "MAW" (megawatt,
 * confirmed via entsoe-py's real request/response handling, Phase 3). EIA:
 * "MWh" (an hourly *energy total*, not a power reading — genuinely a
 * different physical quantity than the other two; docs/architecture.md §2
 * flags reconciling this as a Phase 4 dashboard concern, not silently
 * converted here).
 */
export const unitSchema = z.enum(["MWmed", "MAW", "MWh"]);
export type Unit = z.infer<typeof unitSchema>;

export const sourceSchema = z.enum(["ONS", "ENTSOE", "EIA"]);
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
