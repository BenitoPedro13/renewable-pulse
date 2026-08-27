import { dlqEventSchema, dlqPreviewQuerySchema, dlqPreviewResponseSchema } from "@renewable-pulse/contracts";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { FastifyInstance } from "fastify";

const brokers = process.env.REDPANDA_BROKERS ?? "localhost:19092";
const dlqTopic = process.env.READINGS_DLQ_TOPIC ?? "readings.dlq";

interface CollectedEntry {
  partition: number;
  offset: string;
  raw: unknown;
  error: string;
  sourceTopic: string;
  failedAt: string;
}

/**
 * The same throwaway-consumer-group peek pattern apps/consumer/src/dlq-cli.ts's
 * `list` command already uses, mirrored here rather than shared as a package
 * (docs/tasks/TASK-pipeline-transparency-panel.md §2.1) — read-only, never
 * replays or trims the topic. A fresh group id per call means this never
 * competes with the CLI or a previous request for committed offsets; it
 * always reads from the start of the (small, bounded) DLQ topic.
 */
async function collectDlqPreview(limit: number): Promise<CollectedEntry[]> {
  const kafka = new KafkaJS.Kafka({ "bootstrap.servers": brokers });

  const admin = kafka.admin();
  await admin.connect();
  const offsets = await admin.fetchTopicOffsets(dlqTopic);
  await admin.disconnect();
  const available = offsets.reduce((sum, o) => sum + (Number(o.high) - Number(o.low)), 0);
  if (available === 0) return [];
  const target = Math.min(available, limit);

  const collected: CollectedEntry[] = [];
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `dlq-preview-${Date.now()}`, fromBeginning: true },
  });
  await consumer.connect();
  await consumer.subscribe({ topic: dlqTopic });

  await new Promise<void>((resolve, reject) => {
    consumer
      .run({
        eachMessage: async ({ message, partition }) => {
          if (collected.length >= target || !message.value) return;
          const parsed = dlqEventSchema.safeParse(JSON.parse(message.value.toString("utf8")));
          if (parsed.success) {
            collected.push({
              partition,
              offset: message.offset,
              raw: parsed.data.raw,
              error: parsed.data.error,
              sourceTopic: parsed.data.source_topic,
              failedAt: parsed.data.failed_at,
            });
          }
          if (collected.length >= target) resolve();
        },
      })
      .catch(reject);
  });
  await consumer.disconnect();

  return collected;
}

/**
 * A real-time, read-only preview of readings.dlq for the dashboard's
 * pipeline-transparency panel. Replay is deliberately not exposed here —
 * that stays `pnpm --filter consumer dlq -- replay`, an operator-run CLI
 * action, so a browser-reachable route can never trigger a mutating
 * re-publish onto the readings topic.
 */
export async function pipelineHealthDlqRoute(app: FastifyInstance): Promise<void> {
  app.get("/pipeline-health/dlq", async (request, reply) => {
    const query = dlqPreviewQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });

    const entries = await collectDlqPreview(query.data.limit);
    return dlqPreviewResponseSchema.parse({ entries });
  });
}
