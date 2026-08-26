import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real TimescaleDB via testcontainers, per CLAUDE.md's "integration tests
// against real infra, never mock the broker or database". DATABASE_URL must
// be set before db.ts is imported (it reads it at module load), so the
// container boots first and the persist/db modules are imported dynamically
// after that.
let container: StartedPostgreSqlContainer;
let pool: Pool;
let persistReading: typeof import("./persist.js").persistReading;
let persistReadings: typeof import("./persist.js").persistReadings;
let InvalidReadingError: typeof import("./persist.js").InvalidReadingError;

const baseEvent = {
  source: "ONS",
  zone: "BR-N",
  asset_id: "AMBA",
  metric: "hydro",
  value: 78.13492496172586,
  unit: "MWmed",
  recorded_at: "2026-08-01T00:00:00Z",
  ingested_at: "2026-08-01T12:03:11Z",
  schema_version: 1,
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:latest-pg17")
    .withDatabase("renewable_pulse_test")
    .withUsername("renewable_pulse")
    .withPassword("renewable_pulse")
    .start();

  process.env.DATABASE_URL = container.getConnectionUri();

  const db = await import("./db.js");
  await db.runMigrations();
  pool = db.pool;

  const persist = await import("./persist.js");
  persistReading = persist.persistReading;
  persistReadings = persist.persistReadings;
  InvalidReadingError = persist.InvalidReadingError;
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("persistReading", () => {
  it("upserts a real-shaped ONS plant reading", async () => {
    await persistReading(baseEvent);
    const { rows } = await pool.query("SELECT * FROM readings WHERE asset_id = $1", ["AMBA"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeCloseTo(78.13492496172586);
  });

  it("is idempotent: replaying the same event twice does not duplicate the row", async () => {
    await persistReading(baseEvent);
    await persistReading(baseEvent);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM readings WHERE asset_id = $1",
      ["AMBA"],
    );
    expect(rows[0].n).toBe(1);
  });

  it("treats null asset_id (subsystem-level readings) as distinct from a set asset_id", async () => {
    await persistReading({ ...baseEvent, asset_id: null, metric: "solar" });
    await persistReading({ ...baseEvent, asset_id: null, metric: "solar" });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM readings WHERE asset_id IS NULL AND metric = 'solar'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("rejects a schema-invalid event instead of writing it", async () => {
    await expect(persistReading({ ...baseEvent, zone: "BR-XX" })).rejects.toBeInstanceOf(
      InvalidReadingError,
    );
  });
});

describe("persistReadings (batched upsert)", () => {
  it("upserts a batch of distinct real-shaped readings in one call", async () => {
    const batch = [
      { ...baseEvent, asset_id: "BATCHA", metric: "hydro" },
      { ...baseEvent, asset_id: "BATCHB", metric: "wind" },
      { ...baseEvent, asset_id: "BATCHC", metric: "nuclear" },
    ];
    const result = await persistReadings(batch);
    expect(result.persisted).toBe(3);
    expect(result.invalid).toHaveLength(0);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM readings WHERE asset_id IN ('BATCHA', 'BATCHB', 'BATCHC')",
    );
    expect(rows[0].n).toBe(3);
  });

  it("is idempotent: publishing the same batch twice does not duplicate rows", async () => {
    const batch = [{ ...baseEvent, asset_id: "BATCHIDEMP", metric: "solar" }];
    await persistReadings(batch);
    await persistReadings(batch);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM readings WHERE asset_id = 'BATCHIDEMP'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("dedupes repeated keys within a single batch instead of erroring", async () => {
    const batch = [
      { ...baseEvent, asset_id: "BATCHDUP", metric: "thermal", value: 1 },
      { ...baseEvent, asset_id: "BATCHDUP", metric: "thermal", value: 2 },
    ];
    const result = await persistReadings(batch);
    expect(result.persisted).toBe(1);

    const { rows } = await pool.query("SELECT value FROM readings WHERE asset_id = 'BATCHDUP'");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(2);
  });

  it("persists the valid rows and reports the invalid ones without failing the batch", async () => {
    const batch = [
      { ...baseEvent, asset_id: "BATCHVALID", metric: "hydro" },
      { ...baseEvent, asset_id: "BATCHINVALID", zone: "BR-XX" },
    ];
    const result = await persistReadings(batch);
    expect(result.persisted).toBe(1);
    expect(result.invalid).toHaveLength(1);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM readings WHERE asset_id = 'BATCHVALID'",
    );
    expect(rows[0].n).toBe(1);
  });
});
