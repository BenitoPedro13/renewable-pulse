import { generationMixQuerySchema, generationMixResponseSchema } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

export async function generationMixRoute(app: FastifyInstance): Promise<void> {
  app.get("/generation-mix", async (request, reply) => {
    const query = generationMixQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });
    const { source, zone, from, to, bucket } = query.data;
    const bucketSql = bucket === "hour" ? "bucket_start" : "time_bucket('1 day', bucket_start)";
    const { rows } = await pool.query(
      `SELECT ${bucketSql} AS bucket_start, source, zone, metric, unit,
              SUM(value_sum)::float8 AS value, SUM(reading_count)::int AS reading_count
       FROM generation_hourly
       WHERE source = $1 AND zone = ANY($2) AND bucket_start >= $3 AND bucket_start < $4
       GROUP BY 1, source, zone, metric, unit
       ORDER BY 1, zone, metric, unit`,
      [source, zone, from, to],
    );
    return generationMixResponseSchema.parse({
      rows: rows.map((r) => ({
        bucketStart: r.bucket_start.toISOString(),
        source: r.source,
        zone: r.zone,
        metric: r.metric,
        value: Number(r.value),
        unit: r.unit,
        readingCount: Number(r.reading_count),
      })),
    });
  });
}
