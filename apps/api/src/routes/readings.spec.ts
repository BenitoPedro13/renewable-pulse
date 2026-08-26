import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real TimescaleDB via testcontainers, per CLAUDE.md's "integration tests
// against real infra, never mock the broker or database". DATABASE_URL must
// be set before db.ts is imported (it reads it at module load), so the
// container boots first and db.js/readings.js are imported dynamically
// after that.
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
  await pool.query(
    `INSERT INTO readings (source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version)
     VALUES
       ('ONS', 'BR-N', 'AMBA', 'hydro', 78.13, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-N', NULL, 'solar', 0, 'MWmed', '2026-08-01T01:00:00Z', '2026-08-01T12:00:00Z', 1)`,
  );

  const { readingsRoute } = await import("./readings.js");
  app = Fastify();
  await app.register(readingsRoute);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("GET /readings", () => {
  it("returns real rows as valid JSON matching the contracts schema", async () => {
    const res = await app.inject({ method: "GET", url: "/readings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.readings).toHaveLength(2);
    expect(body.readings[0]).toMatchObject({ source: "ONS", zone: "BR-N" });
  });

  it("respects the limit query param", async () => {
    const res = await app.inject({ method: "GET", url: "/readings?limit=1" });
    expect(res.json().readings).toHaveLength(1);
  });

  it("filters by since", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/readings?since=2026-08-01T00:30:00Z",
    });
    const body = res.json();
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0].metric).toBe("solar");
  });

  it("returns 400 for an invalid query param", async () => {
    const res = await app.inject({ method: "GET", url: "/readings?limit=not-a-number" });
    expect(res.statusCode).toBe(400);
  });
});
