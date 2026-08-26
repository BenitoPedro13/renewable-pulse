import { describe, expect, it } from "vitest";
import { dlqEventSchema } from "./dlq.js";

describe("dlqEventSchema", () => {
  it("accepts an arbitrary raw payload alongside the error metadata", () => {
    const result = dlqEventSchema.safeParse({
      raw: { zone: "BR-XX", metric: "hydro" },
      error: "Invalid enum value for 'zone'",
      source_topic: "readings",
      failed_at: "2026-08-26T12:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing failed_at", () => {
    const result = dlqEventSchema.safeParse({
      raw: {},
      error: "boom",
      source_topic: "readings",
    });
    expect(result.success).toBe(false);
  });
});
