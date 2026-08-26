import { KafkaJS } from "@confluentinc/kafka-javascript";
import { RedpandaContainer, type StartedRedpandaContainer } from "@testcontainers/redpanda";
import type { ReadingEvent } from "@renewable-pulse/contracts";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiveHub } from "./hub.js";
import type { LiveConsumerHandle } from "./consumer.js";

// Real Redpanda via testcontainers and a real `ws` client against a real
// listening Fastify server, per CLAUDE.md's "integration tests against real
// infra, never mock the broker". Deliberately Postgres-free in this file:
// TASK-reliability-layer.md §6 / pipeline-health.spec.ts document that
// running a Postgres testcontainer alongside Redpanda in the same Vitest
// process reproducibly hangs the Kafka *admin* client. This suite never
// touches the admin client (only producer/consumer, the same path
// apps/consumer/src/batch.spec.ts already exercises successfully), so it
// stays isolated in its own file rather than risk that interaction.
//
// A fresh consumer group's rebalance/partition assignment completes some
// time (observed up to a few seconds) after consumer.connect()/run()
// resolve, and fromBeginning:false means anything produced before
// assignment completes is invisible to that consumer — indistinguishable
// from real pre-startup backlog. Rather than guess a fixed settle delay,
// tests that need a message to arrive re-publish it until observed
// (publishUntilSeen); tests proving something must NOT arrive check across
// the whole run instead of racing a single publish.
const TOPIC = "readings";

let redpanda: StartedRedpandaContainer;
let kafka: KafkaJS.Kafka;
let LiveHubCtor: typeof LiveHub;
let startLiveConsumer: typeof import("./consumer.js").startLiveConsumer;
let liveRoute: typeof import("../routes/live.js").liveRoute;

function makeReading(overrides: Partial<ReadingEvent> = {}): ReadingEvent {
  return {
    source: "ONS",
    zone: "BR-N",
    asset_id: "AMBA",
    metric: "hydro",
    value: 42,
    unit: "MWmed",
    recorded_at: "2026-08-01T00:00:00Z",
    ingested_at: "2026-08-01T00:05:00Z",
    schema_version: 1,
    ...overrides,
  };
}

async function publish(messages: unknown[]): Promise<void> {
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({ topic: TOPIC, messages: messages.map((value) => ({ value: JSON.stringify(value) })) });
  await producer.disconnect();
}

function isReadingFrame(frame: unknown, assetId: string): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { type?: string }).type === "reading" &&
    (frame as { reading?: ReadingEvent }).reading?.asset_id === assetId
  );
}

/** Re-publishes `messages` until `frames` contains a reading frame for `expectAssetId`, absorbing the rebalance race described above. */
async function publishUntilSeen(frames: unknown[], messages: unknown[], expectAssetId: string, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (frames.some((f) => isReadingFrame(f, expectAssetId))) return;
    await publish(messages);
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!frames.some((f) => isReadingFrame(f, expectAssetId))) {
    throw new Error(`reading frame for asset_id=${expectAssetId} was not observed after ${attempts} publish attempts`);
  }
}

async function connect(baseWsUrl: string): Promise<{ client: WebSocket; frames: unknown[] }> {
  const client = new WebSocket(`${baseWsUrl}/live`);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  const frames: unknown[] = [];
  client.on("message", (data) => frames.push(JSON.parse(data.toString())));
  return { client, frames };
}

async function startServer(hub: LiveHub): Promise<{ app: FastifyInstance; wsUrl: string }> {
  const app = Fastify();
  await app.register(websocket);
  await app.register(async (instance) => liveRoute(instance, hub));
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, wsUrl: address.replace("http", "ws") };
}

beforeAll(async () => {
  redpanda = await new RedpandaContainer("docker.redpanda.com/redpandadata/redpanda:v26.2.2").start();
  process.env.REDPANDA_BROKERS = redpanda.getBootstrapServers();
  process.env.READINGS_TOPIC = TOPIC;

  kafka = new KafkaJS.Kafka({ "bootstrap.servers": redpanda.getBootstrapServers() });

  ({ LiveHub: LiveHubCtor } = await import("./hub.js"));
  ({ startLiveConsumer } = await import("./consumer.js"));
  ({ liveRoute } = await import("../routes/live.js"));

  // Force topic creation before any test's consumer subscribes.
  await publish([makeReading({ asset_id: "BOOTSTRAP" })]);
}, 120_000);

afterAll(async () => {
  await redpanda?.stop();
});

describe("live route against a real Redpanda broker", () => {
  it(
    "broadcasts a validated canonical reading published after the consumer starts, as a `reading` frame",
    async () => {
      process.env.LIVE_GROUP_ID = `live-test-basic-${Date.now()}`;
      const hub = new LiveHubCtor();
      const consumer: LiveConsumerHandle = await startLiveConsumer(hub);
      const { app, wsUrl } = await startServer(hub);

      try {
        const { client, frames } = await connect(wsUrl);

        await publishUntilSeen(frames, [makeReading({ asset_id: "LIVE-BASIC" })], "LIVE-BASIC");

        client.close();
      } finally {
        await consumer.stop();
        await app.close();
      }
    },
    40_000,
  );

  it(
    "does not broadcast a payload that fails the canonical reading schema, while a valid sibling event still arrives",
    async () => {
      process.env.LIVE_GROUP_ID = `live-test-malformed-${Date.now()}`;
      const hub = new LiveHubCtor();
      const consumer: LiveConsumerHandle = await startLiveConsumer(hub);
      const { app, wsUrl } = await startServer(hub);

      try {
        const { client, frames } = await connect(wsUrl);

        const malformed = { ...makeReading({ asset_id: "MALFORMED-1" }), zone: "NOT-A-REAL-ZONE" };
        const valid = makeReading({ asset_id: "VALID-AFTER-MALFORMED" });
        await publishUntilSeen(frames, [malformed, valid], "VALID-AFTER-MALFORMED");

        expect(frames.some((f) => isReadingFrame(f, "MALFORMED-1"))).toBe(false);

        client.close();
      } finally {
        await consumer.stop();
        await app.close();
      }
    },
    40_000,
  );

  it(
    "does not broadcast backlog published before the consumer's startup cutoff to a freshly connected client",
    async () => {
      await publish([makeReading({ asset_id: "BACKLOG-1" })]);
      // Ensure the backlog message's real Kafka record timestamp is safely
      // before the new consumer group's startup cutoff.
      await new Promise((r) => setTimeout(r, 1500));

      process.env.LIVE_GROUP_ID = `live-test-backlog-${Date.now()}`;
      const hub = new LiveHubCtor();
      const consumer: LiveConsumerHandle = await startLiveConsumer(hub);
      const { app, wsUrl } = await startServer(hub);

      try {
        const { client, frames } = await connect(wsUrl);

        await publishUntilSeen(frames, [makeReading({ asset_id: "FRESH-AFTER-BACKLOG" })], "FRESH-AFTER-BACKLOG");

        expect(frames.some((f) => isReadingFrame(f, "BACKLOG-1"))).toBe(false);

        client.close();
      } finally {
        await consumer.stop();
        await app.close();
      }
    },
    40_000,
  );
});
