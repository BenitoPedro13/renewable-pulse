import { KafkaJS } from "@confluentinc/kafka-javascript";
import { RedpandaContainer, type StartedRedpandaContainer } from "@testcontainers/redpanda";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real Redpanda via testcontainers, per CLAUDE.md's "integration tests
// against real infra, never mock the broker". DLQ messages are produced
// directly in the exact shape apps/consumer/src/batch.ts's real DLQ publish
// path writes ({ raw, error, source_topic, failed_at }, dlqEventSchema) —
// this suite proves the route's own Kafka-peek logic (§2.1 of
// docs/tasks/TASK-pipeline-transparency-panel.md), not the DLQ-routing
// decision itself, which apps/consumer/src/batch.spec.ts already covers
// against real infra.
const DLQ_TOPIC = "readings.dlq";

let redpanda: StartedRedpandaContainer;
let kafka: KafkaJS.Kafka;
let app: FastifyInstance;

function dlqMessage(assetId: string, failedAt: string) {
  return {
    raw: { asset_id: assetId, zone: "BR-XX" },
    error: "invalid zone",
    source_topic: "readings",
    failed_at: failedAt,
  };
}

async function publish(messages: unknown[]): Promise<void> {
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({ topic: DLQ_TOPIC, messages: messages.map((value) => ({ value: JSON.stringify(value) })) });
  await producer.disconnect();
}

beforeAll(async () => {
  redpanda = await new RedpandaContainer("docker.redpanda.com/redpandadata/redpanda:v26.2.2").start();
  process.env.REDPANDA_BROKERS = redpanda.getBootstrapServers();

  kafka = new KafkaJS.Kafka({ "bootstrap.servers": redpanda.getBootstrapServers() });
  await publish([
    dlqMessage("DLQ-TEST-1", "2026-08-01T00:00:00Z"),
    dlqMessage("DLQ-TEST-2", "2026-08-01T00:01:00Z"),
    dlqMessage("DLQ-TEST-3", "2026-08-01T00:02:00Z"),
  ]);

  const { pipelineHealthDlqRoute } = await import("./pipeline-health-dlq.js");
  app = Fastify();
  await app.register(pipelineHealthDlqRoute);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await redpanda?.stop();
});

describe("GET /pipeline-health/dlq", () => {
  it("returns real DLQ entries with the raw/error/sourceTopic/failedAt shape dlq-cli.ts also reads", async () => {
    const res = await app.inject({ method: "GET", url: "/pipeline-health/dlq" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(3);
    expect(body.entries[0]).toMatchObject({
      error: "invalid zone",
      sourceTopic: "readings",
      raw: { zone: "BR-XX" },
    });
  }, 30_000);

  it("respects a limit smaller than the real queue depth", async () => {
    const res = await app.inject({ method: "GET", url: "/pipeline-health/dlq?limit=2" });
    expect(res.json().entries).toHaveLength(2);
  }, 30_000);

  it("rejects a limit over the documented maximum", async () => {
    const res = await app.inject({ method: "GET", url: "/pipeline-health/dlq?limit=500" });
    expect(res.statusCode).toBe(400);
  });
});
