CREATE MATERIALIZED VIEW IF NOT EXISTS generation_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', recorded_at) AS bucket_start,
  source,
  zone,
  metric,
  unit,
  SUM(value) AS value_sum,
  COUNT(*)::bigint AS reading_count
FROM readings
GROUP BY bucket_start, source, zone, metric, unit
WITH NO DATA;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_refresh_continuous_aggregate'
      AND hypertable_name = 'generation_hourly'
  ) THEN
    PERFORM add_continuous_aggregate_policy(
      'generation_hourly',
      start_offset => INTERVAL '35 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour'
    );
  END IF;
END $$;
