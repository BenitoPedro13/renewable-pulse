import { describe, expect, it } from "vitest";
import { cacheControlFor } from "./cache-control.js";

describe("cacheControlFor", () => {
  it("caches GET requests to data routes", () => {
    expect(cacheControlFor("GET", "/generation-mix")).toBe("public, max-age=300, stale-while-revalidate=1800");
    expect(cacheControlFor("GET", "/plants")).not.toBeNull();
  });

  it("never caches pipeline-health — it must reflect current pipeline state", () => {
    expect(cacheControlFor("GET", "/pipeline-health")).toBeNull();
  });

  it("never caches non-GET methods, even on a cacheable path", () => {
    expect(cacheControlFor("POST", "/generation-mix")).toBeNull();
  });

  it("leaves unknown paths uncached", () => {
    expect(cacheControlFor("GET", "/live")).toBeNull();
    expect(cacheControlFor("GET", "/unknown")).toBeNull();
  });
});
