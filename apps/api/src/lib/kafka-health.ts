export type TopicOffset = { partition: number; high: string; low: string };
export type GroupOffsets = { partitions: { partition: number; offset: string }[] }[];

/**
 * Pure arithmetic over already-fetched Kafka admin data — DLQ depth is the
 * DLQ topic's total unread messages; consumer lag is the readings topic's
 * high watermark minus what the "persist" group has committed per
 * partition. Kept dependency-free (no db.js/kafka.js imports) so it can be
 * unit-tested with literal fixture data: see pipeline-health.kafka.spec.ts
 * and docs/tasks/TASK-reliability-layer.md §6 for why the admin client
 * itself isn't exercised in the automated suite.
 */
export function deriveKafkaHealth(
  dlqOffsets: TopicOffset[],
  readingsOffsets: TopicOffset[],
  groupOffsets: GroupOffsets,
): { dlqDepth: number; consumerLag: number } {
  const dlqDepth = dlqOffsets.reduce((sum, o) => sum + (Number(o.high) - Number(o.low)), 0);

  const committedByPartition = new Map<number, string>();
  for (const { partitions } of groupOffsets) {
    for (const p of partitions) {
      committedByPartition.set(p.partition, p.offset);
    }
  }
  const consumerLag = readingsOffsets.reduce((sum, o) => {
    const committed = committedByPartition.get(o.partition);
    // "-1" is librdkafka's marker for "this group has never committed on
    // this partition" — treat that as fully behind (from the low
    // watermark), not as an enormous negative lag.
    const consumedUpTo = committed !== undefined && committed !== "-1" ? Number(committed) : Number(o.low);
    return sum + Math.max(Number(o.high) - consumedUpTo, 0);
  }, 0);

  return { dlqDepth, consumerLag };
}
