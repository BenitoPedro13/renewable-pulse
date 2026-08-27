import { ingestionThroughputQuerySchema, ingestionThroughputResponseSchema } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

/**
 * Real hourly persisted-reading counts per source, for the dashboard's
 * pipeline-transparency panel (docs/tasks/TASK-pipeline-transparency-panel.md
 * §2.2). Reuses the generation_hourly continuous aggregate's own
 * reading_count column — no new migration. zone/metric/unit are dropped from
 * the grouping since this is a volume question, not a value one.
 */
export async function ingestionThroughputRoute(app: FastifyInstance): Promise<void> {
  app.get("/ingestion-throughput", async (request, reply) => {
    const query = ingestionThroughputQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });
    const { from, to } = query.data;

    const { rows } = await pool.query(
      `SELECT bucket_start, source, SUM(reading_count)::int AS reading_count
       FROM generation_hourly
       WHERE bucket_start >= $1 AND bucket_start < $2
       GROUP BY bucket_start, source
       ORDER BY bucket_start, source`,
      [from, to],
    );
    return ingestionThroughputResponseSchema.parse({
      rows: rows.map((r) => ({
        bucketStart: r.bucket_start.toISOString(),
        source: r.source,
        readingCount: Number(r.reading_count),
      })),
    });
  });
}
