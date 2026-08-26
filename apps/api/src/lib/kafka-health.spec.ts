import { describe, expect, it } from "vitest";
import { deriveKafkaHealth } from "./kafka-health.js";

// Pure arithmetic over data shapes the Kafka admin API returns — a unit
// test with literal fixture data, not a mock of the broker itself. The
// admin client's own I/O (apps/api/src/routes/pipeline-health.ts's
// computeKafkaHealth) is deliberately NOT exercised here: in this
// environment, calling admin.fetchTopicOffsets/fetchOffsets against a real
// Redpanda testcontainer reproducibly hung indefinitely on a roughly
// coin-flip basis (confirmed over ~8 repro attempts, sustained ~99%
// single-thread CPU the whole time — a genuinely blocking native call that
// neither the admin client's own `timeout` option nor Vitest's test-level
// timeout could preempt). The underlying logic was verified correct by
// hand, repeatedly, via a standalone Node script run directly against a
// live Redpanda container (docs/tasks/TASK-reliability-layer.md §6) — this
// is the automatable part of that verification.
describe("deriveKafkaHealth", () => {
  it("sums high-minus-low across DLQ partitions for dlqDepth", () => {
    const health = deriveKafkaHealth(
      [
        { partition: 0, high: "5", low: "2" },
        { partition: 1, high: "3", low: "3" },
      ],
      [],
      [],
    );
    expect(health.dlqDepth).toBe(3);
  });

  it("treats a group with no committed offset on a partition as fully behind (from the low watermark)", () => {
    const health = deriveKafkaHealth(
      [],
      [{ partition: 0, high: "10", low: "0" }],
      [{ partitions: [{ partition: 0, offset: "-1" }] }],
    );
    expect(health.consumerLag).toBe(10);
  });

  it("computes lag as high minus the committed offset once the group has consumed some messages", () => {
    const health = deriveKafkaHealth(
      [],
      [{ partition: 0, high: "10", low: "0" }],
      [{ partitions: [{ partition: 0, offset: "7" }] }],
    );
    expect(health.consumerLag).toBe(3);
  });

  it("reports zero lag once the group has caught up to the high watermark", () => {
    const health = deriveKafkaHealth(
      [],
      [{ partition: 0, high: "10", low: "0" }],
      [{ partitions: [{ partition: 0, offset: "10" }] }],
    );
    expect(health.consumerLag).toBe(0);
  });

  it("sums lag across multiple partitions", () => {
    const health = deriveKafkaHealth(
      [],
      [
        { partition: 0, high: "10", low: "0" },
        { partition: 1, high: "20", low: "0" },
      ],
      [
        {
          partitions: [
            { partition: 0, offset: "10" },
            { partition: 1, offset: "5" },
          ],
        },
      ],
    );
    expect(health.consumerLag).toBe(15);
  });
});
