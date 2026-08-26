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
