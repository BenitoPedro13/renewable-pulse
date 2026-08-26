import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real TimescaleDB via testcontainers, running the real migrations owned by
// apps/consumer, per CLAUDE.md's "integration tests against real infra,
// never mock the broker or database".
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

  await pool.query(
    `INSERT INTO readings (source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version)
     VALUES
       -- ONS, hour 0: hydro 100 + thermal 50 (MWmed) = 150 total, 100 included.
       ('ONS', 'BR-N', 'AMBA', 'hydro',   100, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('ONS', 'BR-N', 'TERM', 'thermal', 50,  'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       -- ONS, hour 1 (different zone, still same source/day/unit): hydro 20, all included.
       ('ONS', 'BR-S', 'HID2', 'hydro',   20,  'MWmed', '2026-08-01T01:00:00Z', '2026-08-01T13:00:00Z', 1),
       -- EIA, hour 0: hydro 40 + other 10 (MWh, a genuinely different unit) = 50 total, 40 included.
       ('EIA', 'US-US48', 'US48-HYD', 'hydro', 40, 'MWh', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1),
       ('EIA', 'US-US48', 'US48-OTH', 'other', 10, 'MWh', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1)`,
  );
  // No ENTSOE rows at all: Norway must not appear as a fabricated zero-share row.
  await pool.query(`CALL refresh_continuous_aggregate('generation_hourly', NULL, NULL);`);

  const { generationShareRoute } = await import("./generation-share.js");
  app = Fastify();
  await app.register(generationShareRoute);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("GET /generation-share", () => {
  it("computes hydro+wind+solar share per source without mixing MWmed and MWh across sources", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-share?source=ONS,ENTSOE,EIA&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&bucket=day",
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows;

    // ENTSOE has zero real observations in range: no row is fabricated for it.
    expect(rows.some((r: { source: string }) => r.source === "ENTSOE")).toBe(false);

    const ons = rows.find((r: { source: string }) => r.source === "ONS");
    expect(ons).toMatchObject({
      source: "ONS",
      unit: "MWmed",
      includedValue: 120,
      totalValue: 170,
      includedMetrics: ["hydro", "wind", "solar"],
      observedIntervals: 2,
    });
    expect(ons.share).toBeCloseTo(120 / 170, 10);

    const eia = rows.find((r: { source: string }) => r.source === "EIA");
    expect(eia).toMatchObject({
      source: "EIA",
      unit: "MWh",
      includedValue: 40,
      totalValue: 50,
      observedIntervals: 1,
    });
    expect(eia.share).toBeCloseTo(0.8, 10);
  });

  it("scopes the share calculation to a single requested source", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-share?source=EIA&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&bucket=day",
    });
    const rows = res.json().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("EIA");
  });

  it("returns no rows for a day outside the range with real data", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-share?source=ONS&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z&bucket=day",
    });
    expect(res.json().rows).toEqual([]);
  });

  it("returns 400 for a range exceeding the documented daily maximum", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-share?source=ONS&from=2020-01-01T00:00:00Z&to=2026-08-02T00:00:00Z&bucket=day",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an hour bucket, since v1 only supports day", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/generation-share?source=ONS&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&bucket=hour",
    });
    expect(res.statusCode).toBe(400);
  });
});
