import { z } from "zod";
import { metricSchema, readingEventSchema, sourceSchema, unitSchema, zoneSchema } from "./event.js";

const MAX_HOURLY_DAYS = 35;
const MAX_DAILY_DAYS = 366;
export const hydroWindSolarMetrics = ["hydro", "wind", "solar"] as const;

const dateRangeSchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), "from must be before to");

function maxRange(days: number) {
  return (q: { from: string; to: string }) => Date.parse(q.to) - Date.parse(q.from) <= days * 24 * 60 * 60 * 1000;
}

const csvArray = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    if (Array.isArray(value)) return value.flatMap((v) => String(v).split(","));
    if (typeof value === "string") return value.split(",");
    return value;
  }, z.array(schema).min(1));

/** GET /readings query params. */
export const readingsQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
});
export type ReadingsQuery = z.infer<typeof readingsQuerySchema>;

/** GET /readings response body. */
export const readingsResponseSchema = z.object({
  readings: z.array(readingEventSchema),
});
export type ReadingsResponse = z.infer<typeof readingsResponseSchema>;

/**
 * GET /pipeline-health response body — the three numbers
 * docs/architecture.md §5 calls out as the dashboard's future "pipeline
 * health" panel content. `lastSuccessAt` is `null` (not omitted) for a
 * source that has never produced a persisted reading — a gap shown as
 * missing, not faked, per the project's hard constraint.
 */
export const pipelineHealthResponseSchema = z.object({
  dlqDepth: z.number().int().min(0),
  consumerLag: z.number().int().min(0),
  lastPollBySource: z.array(
    z.object({
      source: sourceSchema,
      lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});

export type PipelineHealthResponse = z.infer<typeof pipelineHealthResponseSchema>;

const generationBucketSchema = z.enum(["hour", "day"]);

export const generationMixQuerySchema = dateRangeSchema
  .extend({ source: sourceSchema, zone: csvArray(zoneSchema), bucket: generationBucketSchema })
  .refine((q) => q.bucket !== "hour" || maxRange(MAX_HOURLY_DAYS)(q), `hour bucket range must be <= ${MAX_HOURLY_DAYS} days`)
  .refine((q) => q.bucket !== "day" || maxRange(MAX_DAILY_DAYS)(q), `day bucket range must be <= ${MAX_DAILY_DAYS} days`);
export type GenerationMixQuery = z.infer<typeof generationMixQuerySchema>;

export const generationMixRowSchema = z.object({
  bucketStart: z.iso.datetime({ offset: true }),
  source: sourceSchema,
  zone: zoneSchema,
  metric: metricSchema,
  value: z.number(),
  unit: unitSchema,
  readingCount: z.number().int().min(0),
});
export const generationMixResponseSchema = z.object({ rows: z.array(generationMixRowSchema) });
export type GenerationMixResponse = z.infer<typeof generationMixResponseSchema>;

export const generationShareQuerySchema = dateRangeSchema
  .extend({ source: csvArray(sourceSchema), bucket: z.literal("day") })
  .refine(maxRange(MAX_DAILY_DAYS), `day bucket range must be <= ${MAX_DAILY_DAYS} days`);
export type GenerationShareQuery = z.infer<typeof generationShareQuerySchema>;

export const generationShareRowSchema = z.object({
  bucketStart: z.iso.datetime({ offset: true }),
  source: sourceSchema,
  share: z.number().min(0).max(1),
  includedMetrics: z.tuple([z.literal("hydro"), z.literal("wind"), z.literal("solar")]),
  includedValue: z.number().nonnegative(),
  totalValue: z.number().positive(),
  unit: unitSchema,
  observedIntervals: z.number().int().min(1),
});
export const generationShareResponseSchema = z.object({ rows: z.array(generationShareRowSchema) });
export type GenerationShareResponse = z.infer<typeof generationShareResponseSchema>;

// source was originally scoped to the literal "ONS" for the Brazil map's
// subsystem-totals panel; widened to the full sourceSchema so the same
// panel can show EIA's US regional totals (docs/tasks/TASK-live-dashboard.md
// §2.8/2.9), mirroring the identical widening already done for
// /generation-mix in §2.7. The route groups by (source, zone, asset_id,
// metric) per row, so a source-scoped query still never mixes units.
export const generationLatestQuerySchema = z.object({ source: sourceSchema, zone: csvArray(zoneSchema).optional() });
export const generationLatestResponseSchema = z.object({ readings: z.array(readingEventSchema) });
export type GenerationLatestResponse = z.infer<typeof generationLatestResponseSchema>;

const MAX_TOP_ASSETS_DAYS = 35;

/**
 * GET /generation-top-assets query params — ranks individual real ONS
 * plants (readings.asset_id) by average output over a window, added
 * 2026-08-26 (docs/tasks/TASK-live-dashboard.md §2.7) for a per-plant
 * leaderboard. `source` is currently ONS-only: EIA's and ENTSO-E's own
 * readings don't carry individual-plant asset_id granularity, only
 * zone/respondent-level. A single `metric` is required (not an array) —
 * "top plants" is inherently a single-fuel-type ranking, not a mixed one.
 */
export const generationTopAssetsQuerySchema = dateRangeSchema
  .extend({
    source: z.literal("ONS"),
    zone: csvArray(zoneSchema).optional(),
    metric: metricSchema,
    limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  })
  .refine(maxRange(MAX_TOP_ASSETS_DAYS), `range must be <= ${MAX_TOP_ASSETS_DAYS} days`);
export type GenerationTopAssetsQuery = z.infer<typeof generationTopAssetsQuerySchema>;

export const generationTopAssetsRowSchema = z.object({
  assetId: z.string(),
  zone: zoneSchema,
  metric: metricSchema,
  avgValue: z.number(),
  unit: unitSchema,
  readingCount: z.number().int().min(1),
});
export const generationTopAssetsResponseSchema = z.object({ rows: z.array(generationTopAssetsRowSchema) });
export type GenerationTopAssetsResponse = z.infer<typeof generationTopAssetsResponseSchema>;

export const plantRegistrySourceSchema = z.enum(["ANEEL_SIGA", "EIA_860"]);
export type PlantRegistrySource = z.infer<typeof plantRegistrySourceSchema>;

/** GET /plants query params. Defaults to ANEEL_SIGA to preserve the original Brazil-only behavior for existing callers. */
export const plantsQuerySchema = z.object({ source: plantRegistrySourceSchema.optional().default("ANEEL_SIGA") });
export type PlantsQuery = z.infer<typeof plantsQuerySchema>;

export const plantSchema = z.object({
  /** The registry's own unique plant identifier — ANEEL's CEG for Brazil, EIA's plantid for the USA. Not the same namespace across sources; only unique within one plantRegistrySource. */
  ceg: z.string(),
  name: z.string(),
  state: z.string(),
  generationType: z.string(),
  /** Canonical metric, mapped server-side from the source's own fuel-type vocabulary (ANEEL's SigTipoGeracao or EIA's technology) — the same categories apps/ingest maps ONS/ENTSO-E/EIA generation readings to, so map markers use the one dashboard-wide palette regardless of registry source. */
  metric: metricSchema,
  phase: z.string().nullable(),
  fuelOrigin: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  /** Real registry capacity, not a live output reading. ANEEL: MdaPotenciaFiscalizadaKw (inspected), falling back to MdaPotenciaOutorgadaKw (granted) when not yet inspected. EIA: nameplate-capacity-mw, summed across a plant's generators, converted to kW for a single cross-source unit. */
  installedCapacityKw: z.number().nullable(),
});
export type Plant = z.infer<typeof plantSchema>;
export const plantsResponseSchema = z.object({
  source: plantRegistrySourceSchema,
  attribution: z.string(),
  unavailable: z.boolean(),
  plants: z.array(plantSchema),
  cachedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PlantsResponse = z.infer<typeof plantsResponseSchema>;

/**
 * GET /pipeline-health/dlq query params — a real-time peek at readings.dlq
 * for the dashboard's pipeline-transparency panel
 * (docs/tasks/TASK-pipeline-transparency-panel.md §2.1). Read-only: replay
 * stays a CLI-only action (apps/consumer's dlq-cli.ts) so a browser-reachable
 * route can never trigger a mutating re-publish.
 */
export const dlqPreviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type DlqPreviewQuery = z.infer<typeof dlqPreviewQuerySchema>;

export const dlqPreviewEntrySchema = z.object({
  partition: z.number().int().min(0),
  offset: z.string(),
  raw: z.unknown(),
  error: z.string(),
  sourceTopic: z.string(),
  failedAt: z.iso.datetime({ offset: true }),
});
export const dlqPreviewResponseSchema = z.object({ entries: z.array(dlqPreviewEntrySchema) });
export type DlqPreviewResponse = z.infer<typeof dlqPreviewResponseSchema>;

/**
 * GET /ingestion-throughput query params — real hourly persisted-reading
 * counts per source, derived from the existing generation_hourly continuous
 * aggregate's own reading_count column (no new migration). zone/metric/unit
 * are deliberately dropped from the grouping: this is a volume question, not
 * a value question, so summing counts across them never risks the
 * unit-mixing problem value-summing would.
 */
export const ingestionThroughputQuerySchema = dateRangeSchema.refine(
  maxRange(MAX_HOURLY_DAYS),
  `range must be <= ${MAX_HOURLY_DAYS} days`,
);
export type IngestionThroughputQuery = z.infer<typeof ingestionThroughputQuerySchema>;

export const ingestionThroughputRowSchema = z.object({
  bucketStart: z.iso.datetime({ offset: true }),
  source: sourceSchema,
  readingCount: z.number().int().min(1),
});
export const ingestionThroughputResponseSchema = z.object({ rows: z.array(ingestionThroughputRowSchema) });
export type IngestionThroughputResponse = z.infer<typeof ingestionThroughputResponseSchema>;

export const liveFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reading"), reading: readingEventSchema }),
  z.object({ type: z.literal("heartbeat"), sentAt: z.iso.datetime({ offset: true }) }),
]);
export type LiveFrame = z.infer<typeof liveFrameSchema>;
