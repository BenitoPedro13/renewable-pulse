import { KafkaJS } from "@confluentinc/kafka-javascript";
import { readingEventSchema } from "@renewable-pulse/contracts";
import type { LiveHub } from "./hub.js";

export interface LiveConsumerHandle { stop(): Promise<void> }

export async function startLiveConsumer(hub: LiveHub): Promise<LiveConsumerHandle> {
  const brokers = process.env.REDPANDA_BROKERS ?? "localhost:19092";
  const topic = process.env.READINGS_TOPIC ?? "readings";
  const groupId = process.env.LIVE_GROUP_ID ?? "live";
  const startupCutoff = Date.now();
  const kafka = new KafkaJS.Kafka({ "bootstrap.servers": brokers });
  const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: false } });

  await consumer.connect();
  await consumer.subscribe({ topic });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const recordTime = Number(message.timestamp);
      if (Number.isFinite(recordTime) && recordTime < startupCutoff) return;
      const parsed = readingEventSchema.safeParse(JSON.parse(message.value.toString("utf8")));
      if (parsed.success) hub.broadcastReading(parsed.data);
    },
  });

  return { stop: async () => consumer.disconnect() };
}
