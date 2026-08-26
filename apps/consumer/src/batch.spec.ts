import { KafkaJS } from "@confluentinc/kafka-javascript";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedpandaContainer, type StartedRedpandaContainer } from "@testcontainers/redpanda";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

// Real Redpanda + real TimescaleDB via testcontainers, per CLAUDE.md's
// "integration tests against real infra, never mock the broker or
// database". DATABASE_URL must be set before db.ts is imported (it reads it
// at module load), so both containers boot first and the app modules are
// imported dynamically after that.
let pgContainer: StartedPostgreSqlContainer;
let redpandaContainer: StartedRedpandaContainer;
let pool: Pool;
let kafka: KafkaJS.Kafka;
let processBatch: typeof import("./batch.js").processBatch;

const SOURCE_TOPIC = "readings";
const DLQ_TOPIC = "readings.dlq";

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
  [pgContainer, redpandaContainer] = await Promise.all([
    new PostgreSqlContainer("timescale/timescaledb:latest-pg17")
      .withDatabase("renewable_pulse_test")
      .withUsername("renewable_pulse")
      .withPassword("renewable_pulse")
      .start(),
    new RedpandaContainer("docker.redpanda.com/redpandadata/redpanda:v26.2.2").start(),
  ]);

  process.env.DATABASE_URL = pgContainer.getConnectionUri();

  const db = await import("./db.js");
  await db.runMigrations();
  pool = db.pool;

  const batch = await import("./batch.js");
  processBatch = batch.processBatch;

  kafka = new KafkaJS.Kafka({ "bootstrap.servers": redpandaContainer.getBootstrapServers() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pgContainer?.stop();
  await redpandaContainer?.stop();
});

/** Reads every currently-available message off `topic` and returns their parsed JSON values. */
async function readAllMessages(topic: string): Promise<unknown[]> {
  const admin = kafka.admin();
  await admin.connect();
  const offsets = await admin.fetchTopicOffsets(topic);
  await admin.disconnect();
  const total = offsets.reduce((sum, o) => sum + (Number(o.high) - Number(o.low)), 0);
  if (total === 0) {
    return [];
  }

  const values: unknown[] = [];
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `test-read-${topic}-${Date.now()}`, fromBeginning: true },
  });
  await consumer.connect();
  await consumer.subscribe({ topic });
  await new Promise<void>((resolve, reject) => {
    consumer
      .run({
        eachMessage: async ({ message }) => {
          if (message.value) {
            values.push(JSON.parse(message.value.toString("utf8")));
          }
          if (values.length >= total) {
            resolve();
          }
        },
      })
      .catch(reject);
  });
  await consumer.disconnect();
  return values;
}

describe("processBatch", () => {
  it(
    "persists valid readings and routes a malformed one in the same batch to the DLQ",
    async () => {
      const producer = kafka.producer();
      await producer.connect();

      const malformed = { ...baseEvent, zone: "BR-XX", asset_id: "DLQ-TEST-1" };
      const result = await processBatch([baseEvent, malformed], {
        producer,
        dlqTopic: DLQ_TOPIC,
        sourceTopic: SOURCE_TOPIC,
      });
      await producer.disconnect();

      expect(result).toEqual({ persisted: 1, dlqRouted: 1 });

      const { rows } = await pool.query("SELECT * FROM readings WHERE asset_id = $1", ["AMBA"]);
      expect(rows).toHaveLength(1);

      const dlqMessages = await readAllMessages(DLQ_TOPIC);
      expect(dlqMessages).toHaveLength(1);
      const dlqMessage = dlqMessages[0] as { raw: unknown; error: string; source_topic: string };
      expect(dlqMessage.source_topic).toBe(SOURCE_TOPIC);
      expect(dlqMessage.raw).toMatchObject({ asset_id: "DLQ-TEST-1", zone: "BR-XX" });
    },
    // The default 5s Vitest timeout is too tight once this runs alongside
    // the rest of the monorepo's suites under turbo's parallelism, where
    // shared CPU/Docker contention slows down the real produce/consume
    // round trips this test does.
    20_000,
  );

  it(
    "persists a full burst (order of magnitude of a real ONS poll) without dropping rows",
    async () => {
      const producer = kafka.producer();
      await producer.connect();

      const burst = Array.from({ length: 50_000 }, (_, i) => ({
        ...baseEvent,
        asset_id: `BURST-${i}`,
        recorded_at: "2026-08-02T00:00:00Z",
      }));

      const started = Date.now();
      const result = await processBatch(burst, {
        producer,
        dlqTopic: DLQ_TOPIC,
        sourceTopic: SOURCE_TOPIC,
      });
      const elapsedMs = Date.now() - started;
      await producer.disconnect();

      expect(result).toEqual({ persisted: 50_000, dlqRouted: 0 });
      // A regression guard against an O(n^2) reintroduction (Phase 1 hit
      // exactly this with a one-row-at-a-time consumer) — not a strict perf
      // budget, just generous enough to fail loudly if batching breaks.
      expect(elapsedMs).toBeLessThan(30_000);

      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM readings WHERE recorded_at = '2026-08-02T00:00:00Z'",
      );
      expect(rows[0].n).toBe(50_000);
    },
    60_000,
  );
});
