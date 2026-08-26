import { describe, expect, it } from "vitest";
import {
  generationMixQuerySchema,
  generationShareRowSchema,
  liveFrameSchema,
  pipelineHealthResponseSchema,
  readingsQuerySchema,
  readingsResponseSchema,
} from "./api.js";

describe("readingsQuerySchema", () => {
  it("defaults limit to 100 when omitted", () => {
    const result = readingsQuerySchema.parse({});
    expect(result.limit).toBe(100);
  });

  it("coerces a string limit query param to a number", () => {
    const result = readingsQuerySchema.parse({ limit: "5" });
    expect(result.limit).toBe(5);
  });

  it("rejects a limit over 1000", () => {
    const result = readingsQuerySchema.safeParse({ limit: "5000" });
    expect(result.success).toBe(false);
  });
});

describe("readingsResponseSchema", () => {
  it("accepts an empty readings array", () => {
    const result = readingsResponseSchema.safeParse({ readings: [] });
    expect(result.success).toBe(true);
  });
});

describe("pipelineHealthResponseSchema", () => {
  it("accepts a null lastSuccessAt for a source with no data yet", () => {
    const result = pipelineHealthResponseSchema.safeParse({
      dlqDepth: 0,
      consumerLag: 0,
      lastPollBySource: [{ source: "ONS", lastSuccessAt: null }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative dlqDepth", () => {
    const result = pipelineHealthResponseSchema.safeParse({
      dlqDepth: -1,
      consumerLag: 0,
      lastPollBySource: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("live dashboard API schemas", () => {
  it("rejects out-of-range hourly generation mix requests", () => {
    const result = generationMixQuerySchema.safeParse({
      source: "ONS",
      zone: "BR-SE",
      bucket: "hour",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-10T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts EIA/ENTSOE as generation-mix sources, not just ONS", () => {
    const eia = generationMixQuerySchema.safeParse({
      source: "EIA",
      zone: "US-US48",
      bucket: "day",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
    });
    expect(eia.success).toBe(true);
  });

  it("still rejects a source outside sourceSchema's enum", () => {
    const result = generationMixQuerySchema.safeParse({
      source: "NOT-A-SOURCE",
      zone: "BR-SE",
      bucket: "day",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects shares outside [0, 1]", () => {
    const result = generationShareRowSchema.safeParse({
      bucketStart: "2026-01-01T00:00:00Z",
      source: "ONS",
      share: 1.2,
      includedMetrics: ["hydro", "wind", "solar"],
      includedValue: 12,
      totalValue: 10,
      unit: "MWmed",
      observedIntervals: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed live frames and unknown units", () => {
    expect(liveFrameSchema.safeParse({ type: "heartbeat", sentAt: "2026-01-01T00:00:00Z" }).success).toBe(true);
    expect(liveFrameSchema.safeParse({ type: "heartbeat", sentAt: "not-a-date" }).success).toBe(false);
    expect(
      liveFrameSchema.safeParse({
        type: "reading",
        reading: {
          source: "ONS",
          zone: "BR-SE",
          asset_id: null,
          metric: "hydro",
          value: 1,
          unit: "GW",
          recorded_at: "2026-01-01T00:00:00Z",
          ingested_at: "2026-01-01T00:00:01Z",
          schema_version: 1,
        },
      }).success,
    ).toBe(false);
  });
});
