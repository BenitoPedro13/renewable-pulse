import { generationTopAssetsQuerySchema, generationTopAssetsResponseSchema } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

/**
 * Ranks individual real ONS plants (readings.asset_id) by average output
 * over the window — a per-plant leaderboard docs/tasks/TASK-live-dashboard.md
 * §2.7 added on top of the zone-level generation-mix/latest/share
 * endpoints, which all aggregate asset_id away. Queries the raw `readings`
 * hypertable directly (not the generation_hourly continuous aggregate,
 * which only groups by zone) — recorded_at bounds the scan to real
 * TimescaleDB chunks.
 */
export async function generationTopAssetsRoute(app: FastifyInstance): Promise<void> {
  app.get("/generation-top-assets", async (request, reply) => {
    const query = generationTopAssetsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });
    const { source, zone, metric, from, to, limit } = query.data;

    const params: unknown[] = [source, metric, from, to];
    let zoneSql = "";
    if (zone?.length) {
      params.push(zone);
      zoneSql = "AND zone = ANY($5)";
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT asset_id, zone, unit, AVG(value)::float8 AS avg_value, COUNT(*)::int AS reading_count
       FROM readings
       WHERE source = $1 AND metric = $2 AND recorded_at >= $3 AND recorded_at < $4
             AND asset_id IS NOT NULL ${zoneSql}
       GROUP BY asset_id, zone, unit
       ORDER BY avg_value DESC
       LIMIT $${params.length}`,
      params,
    );

    return generationTopAssetsResponseSchema.parse({
      rows: rows.map((r) => ({
        assetId: r.asset_id,
        zone: r.zone,
        metric,
        avgValue: Number(r.avg_value),
        unit: r.unit,
        readingCount: Number(r.reading_count),
      })),
    });
  });
}
