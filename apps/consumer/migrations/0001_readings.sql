CREATE TABLE IF NOT EXISTS readings (
  source text NOT NULL,
  zone text NOT NULL,
  asset_id text,
  metric text NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  recorded_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  schema_version smallint NOT NULL
);

SELECT create_hypertable('readings', 'recorded_at', if_not_exists => TRUE);

-- Idempotency key (docs/architecture.md §4): (source, zone, asset_id, metric,
-- recorded_at). asset_id is null for zone/subsystem-level readings, and a
-- plain UNIQUE index treats each NULL as distinct — COALESCE it to a fixed
-- sentinel so subsystem-level rows are still deduplicated correctly.
CREATE UNIQUE INDEX IF NOT EXISTS readings_idempotency_key
  ON readings (source, zone, COALESCE(asset_id, ''), metric, recorded_at);
