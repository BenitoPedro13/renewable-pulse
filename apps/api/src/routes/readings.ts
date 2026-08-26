import { readingsQuerySchema, readingsResponseSchema } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";

export async function readingsRoute(app: FastifyInstance): Promise<void> {
  app.get("/readings", async (request, reply) => {
    const query = readingsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.message });
    }
    const { since, limit } = query.data;

    const { rows } = since
      ? await pool.query(
          `SELECT source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version
             FROM readings WHERE recorded_at > $1 ORDER BY recorded_at DESC LIMIT $2`,
          [since, limit],
        )
      : await pool.query(
          `SELECT source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version
             FROM readings ORDER BY recorded_at DESC LIMIT $1`,
          [limit],
        );

    const readings = rows.map((row) => ({
      ...row,
      recorded_at: row.recorded_at.toISOString(),
      ingested_at: row.ingested_at.toISOString(),
    }));

    return readingsResponseSchema.parse({ readings });
  });
}
