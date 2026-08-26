import { KafkaJS } from "@confluentinc/kafka-javascript";
import { runMigrations } from "./db.js";
import { persistReadings } from "./persist.js";

const brokers = process.env.REDPANDA_BROKERS ?? "localhost:19092";
const topic = process.env.READINGS_TOPIC ?? "readings";

async function main(): Promise<void> {
  await runMigrations();

  const kafka = new KafkaJS.Kafka({ "bootstrap.servers": brokers });
  const consumer = kafka.consumer({
    // A single ONS poll cycle produces hundreds of thousands of readings
    // (docs/architecture.md §2's "bursty batches" story) — the default
    // batch size of 32 means one round trip per 32 rows, which doesn't
    // keep up with that in practice.
    "js.consumer.max.batch.size": 5000,
    kafkaJS: {
      groupId: "persist",
      // "persist" must consume everything ever published, not just new
      // arrivals — a fresh consumer group otherwise defaults to the log end
      // and silently skips whatever was already sitting in the topic.
      fromBeginning: true,
    },
  });

  await consumer.connect();
  await consumer.subscribe({ topic });

  let processed = 0;

  await consumer.run({
    eachBatch: async ({ batch }) => {
      const raws = batch.messages
        .filter((m) => m.value)
        .map((m) => JSON.parse(m.value!.toString("utf8")));

      const { persisted, invalid } = await persistReadings(raws);
      for (const { error } of invalid) {
        // TASK-ingest-spine.md scopes DLQ routing to Phase 2
        // (docs/tasks/TASK-implementation-plan.md §2). For Phase 1, log and
        // skip rather than crash the consumer on the rest of the batch.
        console.error("invalid reading, skipping (DLQ arrives in Phase 2):", error);
      }

      processed += batch.messages.length;
      console.log(
        `persist: batch of ${batch.messages.length} (persisted=${persisted} invalid=${invalid.length}), ${processed} processed so far`,
      );
    },
  });

  console.log(`persist consumer running: brokers=${brokers} topic=${topic}`);
}

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
