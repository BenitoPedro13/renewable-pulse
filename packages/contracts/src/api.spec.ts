import { describe, expect, it } from "vitest";
import { readingsQuerySchema, readingsResponseSchema } from "./api.js";

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
