import type { KafkaJS } from "@confluentinc/kafka-javascript";
import { persistReadings } from "./persist.js";

export interface ProcessBatchDeps {
  producer: KafkaJS.Producer;
  dlqTopic: string;
  sourceTopic: string;
}

export interface ProcessBatchResult {
  persisted: number;
  dlqRouted: number;
}

/**
 * Validates and upserts a raw batch of Kafka message values, routing any
 * schema-invalid/unknown-zone payloads to `dlqTopic` instead of dropping
 * them (docs/architecture.md §5, CLAUDE.md invariant 5). Extracted from
 * index.ts's eachBatch so tests can drive it directly against real
 * testcontainer infra without running the full consumer loop.
 */
export async function processBatch(
  raws: unknown[],
  { producer, dlqTopic, sourceTopic }: ProcessBatchDeps,
): Promise<ProcessBatchResult> {
  const { persisted, invalid } = await persistReadings(raws);

  if (invalid.length > 0) {
    const failedAt = new Date().toISOString();
    await producer.send({
      topic: dlqTopic,
      messages: invalid.map(({ raw, error }) => ({
        value: JSON.stringify({
          raw,
          error,
          source_topic: sourceTopic,
          failed_at: failedAt,
        }),
      })),
    });
  }

  return { persisted, dlqRouted: invalid.length };
}
