#!/usr/bin/env node
// Minimal DLQ inspection/replay tool (docs/tasks/TASK-reliability-layer.md §2).
// Usage: pnpm --filter consumer dlq -- list [--limit=N]
//        pnpm --filter consumer dlq -- replay [--limit=N]
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { dlqEventSchema, type DlqEvent } from "@renewable-pulse/contracts";

const brokers = process.env.REDPANDA_BROKERS ?? "localhost:19092";
const dlqTopic = process.env.READINGS_DLQ_TOPIC ?? "readings.dlq";
const readingsTopic = process.env.READINGS_TOPIC ?? "readings";

interface CollectedMessage {
  partition: number;
  offset: string;
  event: DlqEvent;
}

/** Reads up to `limit` messages currently sitting in readings.dlq (not new arrivals). */
async function collectDlqMessages(
  kafka: KafkaJS.Kafka,
  limit: number,
): Promise<CollectedMessage[]> {
  const admin = kafka.admin();
  await admin.connect();
  const offsets = await admin.fetchTopicOffsets(dlqTopic);
  await admin.disconnect();

  const available = offsets.reduce((sum, o) => sum + (Number(o.high) - Number(o.low)), 0);
  if (available === 0) {
    return [];
  }
  const target = Math.min(available, limit);

  const collected: CollectedMessage[] = [];
  const consumer = kafka.consumer({
    // A throwaway group per invocation: this is a peek/replay tool, not a
    // durable subscriber, so it always reads from the start of the topic.
    kafkaJS: { groupId: `dlq-inspect-${Date.now()}`, fromBeginning: true },
  });
  await consumer.connect();
  await consumer.subscribe({ topic: dlqTopic });

  await new Promise<void>((resolve, reject) => {
    consumer
      .run({
        eachMessage: async ({ message, partition }) => {
          if (collected.length >= target || !message.value) {
            return;
          }
          const parsed = dlqEventSchema.safeParse(JSON.parse(message.value.toString("utf8")));
          if (parsed.success) {
            collected.push({ partition, offset: message.offset, event: parsed.data });
          }
          if (collected.length >= target) {
            resolve();
          }
        },
      })
      .catch(reject);
  });
  await consumer.disconnect();

  return collected;
}

async function list(limit: number): Promise<void> {
  const kafka = new KafkaJS.Kafka({ "bootstrap.servers": brokers });
  const messages = await collectDlqMessages(kafka, limit);

  if (messages.length === 0) {
    console.log(`${dlqTopic} is empty`);
    return;
  }
  for (const { partition, offset, event } of messages) {
    console.log(`[p${partition}@${offset}] ${event.failed_at} source_topic=${event.source_topic}`);
    console.log(`  error: ${event.error}`);
    console.log(`  raw:   ${JSON.stringify(event.raw)}`);
  }
  console.log(`${messages.length} message(s) in ${dlqTopic}`);
}

/**
 * Re-publishes each message's original `raw` payload back onto the readings
 * topic, then trims exactly the replayed range off readings.dlq (via
 * deleteTopicRecords up to the highest offset replayed per partition) — a
 * message that still fails to parse lands right back on the DLQ, which is
 * the correct outcome for a payload that wasn't actually fixed upstream.
 */
async function replay(limit: number): Promise<void> {
  const kafka = new KafkaJS.Kafka({ "bootstrap.servers": brokers });
  const messages = await collectDlqMessages(kafka, limit);

  if (messages.length === 0) {
    console.log(`${dlqTopic} is empty, nothing to replay`);
    return;
  }

  const producer = kafka.producer();
  await producer.connect();
  await producer.send({
    topic: readingsTopic,
    messages: messages.map(({ event }) => ({ value: JSON.stringify(event.raw) })),
  });
  await producer.disconnect();

  const trimTo = new Map<number, bigint>();
  for (const { partition, offset } of messages) {
    const next = BigInt(offset) + 1n;
    const current = trimTo.get(partition);
    if (current === undefined || next > current) {
      trimTo.set(partition, next);
    }
  }

  const admin = kafka.admin();
  await admin.connect();
  await admin.deleteTopicRecords({
    topic: dlqTopic,
    partitions: [...trimTo.entries()].map(([partition, offset]) => ({
      partition,
      offset: offset.toString(),
    })),
  });
  await admin.disconnect();

  console.log(`replayed ${messages.length} message(s) from ${dlqTopic} back onto ${readingsTopic}`);
}

const [, , command, ...rest] = process.argv;
const limitArg = rest.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 100;

switch (command) {
  case "list":
    await list(limit);
    break;
  case "replay":
    await replay(limit);
    break;
  default:
    console.error("usage: dlq-cli <list|replay> [--limit=N]");
    process.exit(1);
}
