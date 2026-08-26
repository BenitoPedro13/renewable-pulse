import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { isOriginAllowed, parseAllowedOrigins } from "./origin.js";

// Exercises the exact origin-check callback index.ts registers with
// @fastify/cors, against a minimal app (no DB/Kafka) via app.inject — no
// real network needed for the REST half of TASK-live-dashboard.md §2.6's
// origin-allowlist requirement. The WebSocket-upgrade half is covered by a
// real listening server + real `ws` client in live.integration.spec.ts,
// since verifyClient can't be exercised through app.inject.
async function buildApp(allowedOrigins: string[]): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, {
    origin(origin, cb) {
      if (isOriginAllowed(origin, allowedOrigins)) cb(null, true);
      else cb(new Error("Origin not allowed"), false);
    },
  });
  app.get("/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("CORS origin allowlist", () => {
  it("allows a listed browser origin and echoes it back in Access-Control-Allow-Origin", async () => {
    app = await buildApp(["http://localhost:3000"]);
    const res = await app.inject({ method: "GET", url: "/ping", headers: { origin: "http://localhost:3000" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("rejects a request from an origin outside the allowlist", async () => {
    app = await buildApp(["http://localhost:3000"]);
    const res = await app.inject({ method: "GET", url: "/ping", headers: { origin: "http://evil.example" } });
    expect(res.statusCode).not.toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a request with no Origin header (non-browser clients like curl or server-to-server calls)", async () => {
    app = await buildApp(["http://localhost:3000"]);
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
  });
});

describe("parseAllowedOrigins", () => {
  it("splits a comma-separated ALLOWED_ORIGINS value and trims whitespace around each entry", () => {
    expect(parseAllowedOrigins("http://a.example, http://b.example")).toEqual([
      "http://a.example",
      "http://b.example",
    ]);
  });

  it("defaults to http://localhost:3000 when ALLOWED_ORIGINS is unset", () => {
    expect(parseAllowedOrigins(undefined)).toEqual(["http://localhost:3000"]);
  });

  it("drops empty entries produced by a trailing comma", () => {
    expect(parseAllowedOrigins("http://a.example,")).toEqual(["http://a.example"]);
  });
});
