import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real TimescaleDB via testcontainers, running the real migrations owned by
// apps/consumer (this route reads the generation_hourly continuous
// aggregate migration 0002 creates), matching generation-mix.spec.ts's setup
// exactly per CLAUDE.md's "integration tests against real infra".
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "consumer", "migrations");

async function runMigrations(pool: Pool): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await pool.query(await readFile(path.join(migrationsDir, file), "utf8"));
  }
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:latest-pg17")
    .withDatabase("renewable_pulse_test")
    .withUsername("renewable_pulse")
    .withPassword("renewable_pulse")
    .start();

  process.env.DATABASE_URL = container.getConnectionUri();

  const db = await import("../db.js");
  pool = db.pool;
  await runMigrations(pool);

  // Two real-shaped ONS readings and one EIA reading in the same hour, plus
  // an ONS reading in the next hour — proves per-source/per-hour summing
  // across zone/metric/unit without mixing sources together.
  await pool.query(
    `INSERT INTO readings (source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version)
     VALUES
       ('ONS', 'BR-N', 'AMBA', 'hydro', 100, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-NE', 'XYZ', 'wind', 30, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('EIA', 'US-US48', NULL, 'thermal', 500, 'MWh', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-N', 'AMBA', 'hydro', 50, 'MWmed', '2026-08-01T01:00:00Z', '2026-08-01T12:00:00Z', 1)`,
  );
  await pool.query(`CALL refresh_continuous_aggregate('generation_hourly', NULL, NULL);`);

  const { ingestionThroughputRoute } = await import("./ingestion-throughput.js");
  app = Fastify();
  await app.register(ingestionThroughputRoute);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("GET /ingestion-throughput", () => {
  it("sums reading_count per source/hour across zones/metrics without mixing sources", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ingestion-throughput?from=2026-08-01T00:00:00Z&to=2026-08-01T02:00:00Z",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([
      { bucketStart: "2026-08-01T00:00:00.000Z", source: "EIA", readingCount: 1 },
      { bucketStart: "2026-08-01T00:00:00.000Z", source: "ONS", readingCount: 2 },
      { bucketStart: "2026-08-01T01:00:00.000Z", source: "ONS", readingCount: 1 },
    ]);
  });

  it("omits an hour with no real readings for a source instead of a generated zero", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ingestion-throughput?from=2026-08-01T02:00:00Z&to=2026-08-01T03:00:00Z",
    });
    expect(res.json().rows).toEqual([]);
  });

  it("rejects a range wider than the documented maximum", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ingestion-throughput?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z",
    });
    expect(res.statusCode).toBe(400);
  });
});
