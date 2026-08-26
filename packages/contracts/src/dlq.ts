import { z } from "zod";

/**
 * The shape every dead-lettered message takes, regardless of which topic or
 * consumer produced it (docs/architecture.md §5, CLAUDE.md invariant 5: a
 * DLQ, not a dropped or crashing consumer). `raw` is deliberately `unknown`
 * — it's whatever failed to parse, so it can't be constrained further.
 */
export const dlqEventSchema = z.object({
  raw: z.unknown(),
  error: z.string(),
  source_topic: z.string(),
  failed_at: z.iso.datetime({ offset: true }),
});

export type DlqEvent = z.infer<typeof dlqEventSchema>;
