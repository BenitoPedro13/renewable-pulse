import { z } from "zod";
import { readingEventSchema, sourceSchema } from "./event.js";

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
