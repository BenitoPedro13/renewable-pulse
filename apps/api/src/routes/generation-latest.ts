import { generationLatestQuerySchema, generationLatestResponseSchema } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

export async function generationLatestRoute(app: FastifyInstance): Promise<void> {
  app.get("/generation-latest", async (request, reply) => {
    const query = generationLatestQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });
    const zones = query.data.zone;
    const params: unknown[] = [query.data.source];
    let zoneSql = "";
    if (zones?.length) {
      params.push(zones);
      zoneSql = "AND zone = ANY($2)";
    }
    const { rows } = await pool.query(
      `SELECT source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY source, zone, asset_id, metric ORDER BY recorded_at DESC) rn
         FROM readings WHERE source = $1 ${zoneSql}
       ) r WHERE rn = 1 ORDER BY zone, metric, asset_id NULLS FIRST`,
      params,
    );
    return generationLatestResponseSchema.parse({
      readings: rows.map((r) => ({ ...r, recorded_at: r.recorded_at.toISOString(), ingested_at: r.ingested_at.toISOString() })),
    });
  });
}
