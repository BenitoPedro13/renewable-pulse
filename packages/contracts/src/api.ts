import { z } from "zod";
import { readingEventSchema } from "./event.js";

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
