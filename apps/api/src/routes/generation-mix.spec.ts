import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real TimescaleDB via testcontainers, running the real migrations owned by
// apps/consumer (this route reads the `generation_hourly` continuous
// aggregate migration 0002 creates), per CLAUDE.md's "integration tests
// against real infra, never mock the broker or database".
const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "consumer",
  "migrations",
);

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

  // Two real-shaped ONS readings in the same UTC hour (summed by the
  // aggregate) and one in the next hour, plus a second zone/metric pair to
  // prove grouping doesn't cross zone/metric/unit boundaries.
  await pool.query(
    `INSERT INTO readings (source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version)
     VALUES
       ('ONS', 'BR-N', 'AMBA', 'hydro', 100, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-N', 'AMBA', 'hydro', 200, 'MWmed', '2026-08-01T00:30:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-N', 'AMBA', 'hydro', 50,  'MWmed', '2026-08-01T01:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-NE', 'XYZ', 'wind', 30, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1)`,
  );
  await pool.query(`CALL refresh_continuous_aggregate('generation_hourly', NULL, NULL);`);

  const { generationMixRoute } = await import("./generation-mix.js");
  app = Fastify();
  await app.register(generationMixRoute);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("GET /generation-mix", () => {
  it("returns hourly sums per source/zone/metric/unit, preserving the MWmed unit label", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-mix?source=ONS&zone=BR-N&from=2026-08-01T00:00:00Z&to=2026-08-01T02:00:00Z&bucket=hour",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toEqual([
      {
        bucketStart: "2026-08-01T00:00:00.000Z",
        source: "ONS",
        zone: "BR-N",
        metric: "hydro",
        value: 300,
        unit: "MWmed",
        readingCount: 2,
      },
      {
        bucketStart: "2026-08-01T01:00:00.000Z",
        source: "ONS",
        zone: "BR-N",
        metric: "hydro",
        value: 50,
        unit: "MWmed",
        readingCount: 1,
      },
    ]);
  });

  it("never mixes rows across zones even when both are requested", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-mix?source=ONS&zone=BR-N,BR-NE&from=2026-08-01T00:00:00Z&to=2026-08-01T02:00:00Z&bucket=hour",
    });
    const zones = res.json().rows.map((r: { zone: string }) => r.zone);
    expect(new Set(zones)).toEqual(new Set(["BR-N", "BR-NE"]));
    // Each row still carries a single zone/metric — no cross-zone summation.
    const neRow = res.json().rows.find((r: { zone: string }) => r.zone === "BR-NE");
    expect(neRow).toMatchObject({ metric: "wind", value: 30, unit: "MWmed" });
  });

  it("rolls up to daily buckets when bucket=day is requested", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-mix?source=ONS&zone=BR-N&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&bucket=day",
    });
    const body = res.json();
    expect(body.rows).toEqual([
      {
        bucketStart: "2026-08-01T00:00:00.000Z",
        source: "ONS",
        zone: "BR-N",
        metric: "hydro",
        value: 350,
        unit: "MWmed",
        readingCount: 3,
      },
    ]);
  });

  it("omits an hour with no real readings instead of returning a zero/interpolated row", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-mix?source=ONS&zone=BR-N&from=2026-08-01T02:00:00Z&to=2026-08-01T03:00:00Z&bucket=hour",
    });
    expect(res.json().rows).toEqual([]);
  });

  it("rejects an hour-bucket range wider than the documented 35-day maximum", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-mix?source=ONS&zone=BR-N&from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z&bucket=hour",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an unknown zone instead of silently widening the query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-mix?source=ONS&zone=NOT-A-ZONE&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&bucket=hour",
    });
    expect(res.statusCode).toBe(400);
  });
});
