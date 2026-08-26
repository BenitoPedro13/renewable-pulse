import { pipelineHealthResponseSchema, sourceSchema } from "@renewable-pulse/contracts";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { withAdmin } from "../kafka.js";
import { deriveKafkaHealth } from "../lib/kafka-health.js";

const READINGS_TOPIC = process.env.READINGS_TOPIC ?? "readings";
const DLQ_TOPIC = process.env.READINGS_DLQ_TOPIC ?? "readings.dlq";
const PERSIST_GROUP = "persist";
const ADMIN_TIMEOUT_MS = 10_000;

/**
 * DLQ depth and consumer lag — the Kafka-derived half of §5's three
 * observability numbers. The actual admin-client I/O is a thin wrapper
 * around deriveKafkaHealth (see that function's doc comment for why the
 * split exists).
 */
export async function computeKafkaHealth(): Promise<{ dlqDepth: number; consumerLag: number }> {
  const offsetOptions = {
    timeout: ADMIN_TIMEOUT_MS,
    isolationLevel: KafkaJS.IsolationLevel.READ_UNCOMMITTED,
  };

  const { dlqOffsets, readingsOffsets, groupOffsets } = await withAdmin(async (admin) => {
    const [dlqOffsets, readingsOffsets] = await Promise.all([
      admin.fetchTopicOffsets(DLQ_TOPIC, offsetOptions),
      admin.fetchTopicOffsets(READINGS_TOPIC, offsetOptions),
    ]);
    // Before the "persist" consumer group has ever connected, fetching its
    // offsets fails (the group doesn't exist yet) rather than returning an
    // empty result — treat that the same as "nothing committed anywhere",
    // i.e. fully behind, which is the true state of a pipeline that hasn't
    // started consuming yet.
    const groupOffsets = await admin
      .fetchOffsets({ groupId: PERSIST_GROUP, topics: [READINGS_TOPIC], timeout: ADMIN_TIMEOUT_MS })
      .catch(() => [] as Awaited<ReturnType<typeof admin.fetchOffsets>>);
    return { dlqOffsets, readingsOffsets, groupOffsets };
  });

  return deriveKafkaHealth(dlqOffsets, readingsOffsets, groupOffsets);
}

/** Last-successful-poll-per-source — the Postgres-derived half of §5's three numbers. */
export async function computeLastPollBySource(): Promise<
  { source: (typeof sourceSchema.options)[number]; lastSuccessAt: string | null }[]
> {
  const result = await pool.query<{ source: string; last_success_at: Date }>(
    "SELECT source, MAX(ingested_at) AS last_success_at FROM readings GROUP BY source",
  );
  const lastSuccessBySource = new Map(
    result.rows.map((row) => [row.source, row.last_success_at.toISOString()]),
  );
  return sourceSchema.options.map((source) => ({
    source,
    lastSuccessAt: lastSuccessBySource.get(source) ?? null,
  }));
}

/**
 * The three numbers docs/architecture.md §5 calls out for the dashboard's
 * future "pipeline health" panel, defined once here so both this endpoint
 * and any script can read them consistently
 * (docs/tasks/TASK-reliability-layer.md §2).
 */
export async function pipelineHealthRoute(app: FastifyInstance): Promise<void> {
  app.get("/pipeline-health", async () => {
    const [{ dlqDepth, consumerLag }, lastPollBySource] = await Promise.all([
      computeKafkaHealth(),
      computeLastPollBySource(),
    ]);
    return pipelineHealthResponseSchema.parse({ dlqDepth, consumerLag, lastPollBySource });
  });
}
