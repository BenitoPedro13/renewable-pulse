import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real TimescaleDB via testcontainers, per CLAUDE.md's "integration tests
// against real infra, never mock the broker or database". DATABASE_URL must
// be set before db.ts is imported (it reads it at module load), so the
// container boots first and db.js/generation-latest.js are imported
// dynamically after that.
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
  await pool.query(`
    CREATE TABLE readings (
      source text NOT NULL,
      zone text NOT NULL,
      asset_id text,
      metric text NOT NULL,
      value double precision NOT NULL,
      unit text NOT NULL,
      recorded_at timestamptz NOT NULL,
      ingested_at timestamptz NOT NULL,
      schema_version smallint NOT NULL
    );
  `);
  // Two recorded_at values for the same (source, zone, asset_id, metric)
  // key, plus a subsystem-level row (asset_id NULL) and an unrelated zone,
  // so the "latest per key" window function has something to prove.
  await pool.query(
    `INSERT INTO readings (source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version)
     VALUES
       ('ONS', 'BR-N', 'AMBA', 'hydro', 78.13, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-N', 'AMBA', 'hydro', 91.02, 'MWmed', '2026-08-01T01:00:00Z', '2026-08-01T13:00:00Z', 1),
       ('ONS', 'BR-N', NULL,   'solar', 0,     'MWmed', '2026-08-01T01:00:00Z', '2026-08-01T13:00:00Z', 1),
       ('ONS', 'BR-NE', 'XYZ', 'wind',  30,    'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1)`,
  );

  const { generationLatestRoute } = await import("./generation-latest.js");
  app = Fastify();
  await app.register(generationLatestRoute);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("GET /generation-latest", () => {
  it("returns only the most recent real reading per (source, zone, asset_id, metric), not every row", async () => {
    const res = await app.inject({ method: "GET", url: "/generation-latest?source=ONS" });
    expect(res.statusCode).toBe(200);
    const readings = res.json().readings;
    expect(readings).toHaveLength(3);
    const amba = readings.find((r: { asset_id: string | null }) => r.asset_id === "AMBA");
    expect(amba).toMatchObject({ value: 91.02, recorded_at: "2026-08-01T01:00:00.000Z" });
  });

  it("treats a null asset_id (subsystem-level reading) as its own key, distinct from a set asset_id", async () => {
    const res = await app.inject({ method: "GET", url: "/generation-latest?source=ONS&zone=BR-N" });
    const readings = res.json().readings;
    const subsystem = readings.find((r: { asset_id: string | null; metric: string }) => r.metric === "solar");
    expect(subsystem.asset_id).toBeNull();
  });

  it("filters to the requested zones only", async () => {
    const res = await app.inject({ method: "GET", url: "/generation-latest?source=ONS&zone=BR-NE" });
    const readings = res.json().readings;
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ zone: "BR-NE", asset_id: "XYZ" });
  });

  it("returns 400 for a source other than ONS", async () => {
    const res = await app.inject({ method: "GET", url: "/generation-latest?source=ENTSOE" });
    expect(res.statusCode).toBe(400);
  });
});
