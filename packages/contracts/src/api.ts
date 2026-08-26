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
  .extend({ source: z.literal("ONS"), zone: csvArray(zoneSchema), bucket: generationBucketSchema })
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

export const generationLatestQuerySchema = z.object({ source: z.literal("ONS"), zone: csvArray(zoneSchema).optional() });
export const generationLatestResponseSchema = z.object({ readings: z.array(readingEventSchema) });
export type GenerationLatestResponse = z.infer<typeof generationLatestResponseSchema>;

export const plantSchema = z.object({
  ceg: z.string(),
  name: z.string(),
  state: z.string(),
  generationType: z.string(),
  phase: z.string().nullable(),
  fuelOrigin: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
});
export const plantsResponseSchema = z.object({
  source: z.literal("ANEEL_SIGA"),
  attribution: z.string(),
  unavailable: z.boolean(),
  plants: z.array(plantSchema),
  cachedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PlantsResponse = z.infer<typeof plantsResponseSchema>;

export const liveFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reading"), reading: readingEventSchema }),
  z.object({ type: z.literal("heartbeat"), sentAt: z.iso.datetime({ offset: true }) }),
]);
export type LiveFrame = z.infer<typeof liveFrameSchema>;
