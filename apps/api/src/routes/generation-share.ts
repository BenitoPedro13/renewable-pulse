import { generationShareQuerySchema, generationShareResponseSchema, hydroWindSolarMetrics } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

export async function generationShareRoute(app: FastifyInstance): Promise<void> {
  app.get("/generation-share", async (request, reply) => {
    const query = generationShareQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });
    const { source, from, to } = query.data;
    const { rows } = await pool.query(
      `SELECT time_bucket('1 day', bucket_start) AS bucket_start, source, unit,
              SUM(value_sum)::float8 AS total_value,
              SUM(value_sum) FILTER (WHERE metric = ANY($4))::float8 AS included_value,
              COUNT(DISTINCT bucket_start)::int AS observed_intervals
       FROM generation_hourly
       WHERE source = ANY($1) AND bucket_start >= $2 AND bucket_start < $3
       GROUP BY 1, source, unit
       HAVING SUM(value_sum) > 0
       ORDER BY bucket_start, source, unit`,
      [source, from, to, hydroWindSolarMetrics],
    );
    return generationShareResponseSchema.parse({
      rows: rows.map((r) => ({
        bucketStart: r.bucket_start.toISOString(),
        source: r.source,
        share: Number(r.included_value ?? 0) / Number(r.total_value),
        includedMetrics: hydroWindSolarMetrics,
        includedValue: Number(r.included_value ?? 0),
        totalValue: Number(r.total_value),
        unit: r.unit,
        observedIntervals: Number(r.observed_intervals),
      })),
    });
  });
}
