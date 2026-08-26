import { describe, expect, it } from "vitest";
import { readingEventSchema } from "./event.js";

describe("readingEventSchema", () => {
  it("accepts a real-shaped ONS plant reading", () => {
    const result = readingEventSchema.safeParse({
      source: "ONS",
      zone: "BR-N",
      asset_id: "AMBA",
      metric: "hydro",
      value: 78.13492496172586,
      unit: "MWmed",
      recorded_at: "2026-08-01T00:00:00Z",
      ingested_at: "2026-08-01T12:03:11Z",
      schema_version: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null asset_id for aggregated/subsystem-level readings", () => {
    const result = readingEventSchema.safeParse({
      source: "ONS",
      zone: "BR-N",
      asset_id: null,
      metric: "solar",
      value: 0,
      unit: "MWmed",
      recorded_at: "2026-08-01T00:00:00Z",
      ingested_at: "2026-08-01T12:03:11Z",
      schema_version: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown zone", () => {
    const result = readingEventSchema.safeParse({
      source: "ONS",
      zone: "BR-XX",
      asset_id: null,
      metric: "hydro",
      value: 1,
      unit: "MWmed",
      recorded_at: "2026-08-01T00:00:00Z",
      ingested_at: "2026-08-01T12:03:11Z",
      schema_version: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a real-shaped ENTSO-E Norway reading", () => {
    const result = readingEventSchema.safeParse({
      source: "ENTSOE",
      zone: "NO-NO1",
      asset_id: null,
      metric: "hydro",
      value: 4213,
      unit: "MAW",
      recorded_at: "2026-08-26T05:00:00Z",
      ingested_at: "2026-08-26T06:00:11Z",
      schema_version: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a real-shaped EIA USA reading", () => {
    const result = readingEventSchema.safeParse({
      source: "EIA",
      zone: "US-US48",
      asset_id: null,
      metric: "wind",
      value: 98234,
      unit: "MWh",
      recorded_at: "2026-08-26T05:00:00Z",
      ingested_at: "2026-08-26T06:00:11Z",
      schema_version: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing recorded_at", () => {
    const result = readingEventSchema.safeParse({
      source: "ONS",
      zone: "BR-N",
      asset_id: null,
      metric: "hydro",
      value: 1,
      unit: "MWmed",
      ingested_at: "2026-08-01T12:03:11Z",
      schema_version: 1,
    });
    expect(result.success).toBe(false);
  });
});
