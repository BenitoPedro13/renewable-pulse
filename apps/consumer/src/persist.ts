import { readingEventSchema, type ReadingEvent } from "@renewable-pulse/contracts";
import { pool } from "./db.js";

const COLUMNS = [
  "source",
  "zone",
  "asset_id",
  "metric",
  "value",
  "unit",
  "recorded_at",
  "ingested_at",
  "schema_version",
] as const satisfies readonly (keyof ReadingEvent)[];

export class InvalidReadingError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = "InvalidReadingError";
  }
}

/**
 * Validates a raw Kafka message payload against the canonical event schema
 * and upserts it into TimescaleDB on the idempotency key
 * (source, zone, asset_id, metric, recorded_at). Throws InvalidReadingError
 * for schema-invalid/unknown-zone payloads — the caller routes those to
 * readings.dlq instead of failing the batch (docs/architecture.md §4/§5).
 */
export async function persistReading(raw: unknown): Promise<void> {
  const parsed = readingEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidReadingError(parsed.error.message, raw);
  }

  const event = parsed.data;
  await pool.query(
    `INSERT INTO readings
       (source, zone, asset_id, metric, value, unit, recorded_at, ingested_at, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source, zone, COALESCE(asset_id, ''), metric, recorded_at)
     DO UPDATE SET
       value = EXCLUDED.value,
       unit = EXCLUDED.unit,
       ingested_at = EXCLUDED.ingested_at,
       schema_version = EXCLUDED.schema_version`,
    [
      event.source,
      event.zone,
      event.asset_id,
      event.metric,
      event.value,
      event.unit,
      event.recorded_at,
      event.ingested_at,
      event.schema_version,
    ],
  );
}

export interface PersistBatchResult {
  persisted: number;
  invalid: { raw: unknown; error: string }[];
}

/**
 * Batched form of persistReading: validates every raw payload, then upserts
 * all valid ones in a single multi-row statement. Schema-invalid payloads
 * are collected in `invalid` rather than blocking the rest of the batch —
 * the same DLQ-routing posture persistReading documents, applied per-batch.
 *
 * Kafka messages arrive one plant-reading at a time but a single ONS poll
 * cycle produces hundreds of thousands of them (docs/architecture.md §2's
 * "bursty batches" story) — one round trip per row doesn't keep up with
 * that in practice, so eachBatch + this function replaces eachMessage +
 * persistReading as the consumer's real entrypoint.
 */
export async function persistReadings(raws: unknown[]): Promise<PersistBatchResult> {
  const valid: ReadingEvent[] = [];
  const invalid: PersistBatchResult["invalid"] = [];

  for (const raw of raws) {
    const parsed = readingEventSchema.safeParse(raw);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      invalid.push({ raw, error: parsed.error.message });
    }
  }

  if (valid.length === 0) {
    return { persisted: 0, invalid };
  }

  // A single multi-row ON CONFLICT DO UPDATE errors if the same row is
  // targeted twice in one statement — dedupe by idempotency key within the
  // batch first (last occurrence wins, same outcome sequential upserts
  // would produce).
  const byKey = new Map<string, ReadingEvent>();
  for (const event of valid) {
    byKey.set(
      `${event.source}|${event.zone}|${event.asset_id ?? ""}|${event.metric}|${event.recorded_at}`,
      event,
    );
  }
  const deduped = [...byKey.values()];

  // Postgres caps a single statement at 65535 bind parameters. A batch
  // larger than ~7280 rows (65535 / 9 columns) would blow past that in one
  // multi-row INSERT — chunking keeps every statement well under the limit
  // regardless of how large a caller's batch is (persist.spec.ts's burst
  // test caught this at 50k rows; docs/tasks/TASK-reliability-layer.md).
  for (let start = 0; start < deduped.length; start += MAX_ROWS_PER_STATEMENT) {
    await insertChunk(deduped.slice(start, start + MAX_ROWS_PER_STATEMENT));
  }

  return { persisted: deduped.length, invalid };
}

const MAX_ROWS_PER_STATEMENT = 5000;

async function insertChunk(events: ReadingEvent[]): Promise<void> {
  const values: unknown[] = [];
  const rows: string[] = [];
  for (const [i, event] of events.entries()) {
    const base = i * COLUMNS.length;
    const placeholders = COLUMNS.map((_, j) => `$${base + j + 1}`);
    rows.push(`(${placeholders.join(", ")})`);
    values.push(...COLUMNS.map((col) => event[col]));
  }

  await pool.query(
    `INSERT INTO readings (${COLUMNS.join(", ")})
     VALUES ${rows.join(",\n            ")}
     ON CONFLICT (source, zone, COALESCE(asset_id, ''), metric, recorded_at)
     DO UPDATE SET
       value = EXCLUDED.value,
       unit = EXCLUDED.unit,
       ingested_at = EXCLUDED.ingested_at,
       schema_version = EXCLUDED.schema_version`,
    values,
  );
}
