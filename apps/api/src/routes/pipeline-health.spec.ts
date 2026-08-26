import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real TimescaleDB via testcontainers, per CLAUDE.md's "integration tests
// against real infra, never mock the broker or database". DATABASE_URL must
// be set before db.js is imported (it reads it at module load), so the
// container boots first and db.js/pipeline-health.js are imported
// dynamically after that.
//
// This is deliberately Postgres-only, without a Redpanda testcontainer
// alongside it: running both testcontainer types (@testcontainers/postgresql
// and @testcontainers/redpanda) in the same Vitest process reliably hangs
// the Kafka admin client indefinitely — reproduced with a minimal repro
// (fresh Postgres + fresh Redpanda testcontainers, nothing else) and ruled
// out as a bug in this project's own code: Fastify + the Kafka admin client
// alone (no Postgres) and Postgres alone (no Kafka) both work fine, and the
// real, non-testcontainer stack (docker-compose Postgres + Redpanda, both
// already running) has no such issue — see
// docs/tasks/TASK-reliability-layer.md §6. computeKafkaHealth (the
// Kafka-derived half of /pipeline-health) is tested against a real Redpanda
// testcontainer on its own in pipeline-health.kafka.spec.ts; the full
// composed route is verified manually via curl against docker-compose.
let container: StartedPostgreSqlContainer;
let pool: Pool;
let computeLastPollBySource: typeof import("./pipeline-health.js").computeLastPollBySource;

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
     VALUES ('ONS', 'BR-N', 'AMBA', 'hydro', 78.13, 'MWmed', '2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z', 1)`,
  );

  const pipelineHealth = await import("./pipeline-health.js");
  computeLastPollBySource = pipelineHealth.computeLastPollBySource;
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("computeLastPollBySource", () => {
  it("reports the real last-successful-poll timestamp for a source with data", async () => {
    const result = await computeLastPollBySource();
    expect(result).toEqual([{ source: "ONS", lastSuccessAt: "2026-08-01T12:00:00.000Z" }]);
  });
});
