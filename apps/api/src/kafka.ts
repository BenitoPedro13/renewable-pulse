import { KafkaJS } from "@confluentinc/kafka-javascript";

const brokers = process.env.REDPANDA_BROKERS ?? "localhost:19092";

const kafka = new KafkaJS.Kafka({ "bootstrap.servers": brokers });

/**
 * A fresh, short-lived admin client per call rather than one long-lived
 * shared instance — /pipeline-health is a low-frequency diagnostic
 * endpoint, and a reused admin client observably went stale (spurious
 * "Local: Timed out" on its second real request) across the request
 * boundary during testing.
 */
export async function withAdmin<T>(fn: (admin: KafkaJS.Admin) => Promise<T>): Promise<T> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.disconnect();
  }
}
