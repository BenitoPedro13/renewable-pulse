import { EventEmitter } from "node:events";
import type { ReadingEvent } from "@renewable-pulse/contracts";
import { describe, expect, it, vi } from "vitest";
import { LiveHub } from "./hub.js";

// Pure fan-out logic over the `ws`-shaped client interface LiveHub actually
// uses (once/send/close/bufferedAmount) — a fake socket, not a mocked
// broker. The real Kafka-to-WebSocket wire is covered end-to-end against a
// real Redpanda testcontainer and a real `ws` client in
// live.integration.spec.ts.
class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  sent: string[] = [];
  closed?: { code: number; reason: string };

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.emit("close");
  }
}

const reading: ReadingEvent = {
  source: "ONS",
  zone: "BR-N",
  asset_id: "AMBA",
  metric: "hydro",
  value: 78.13,
  unit: "MWmed",
  recorded_at: "2026-08-01T00:00:00Z",
  ingested_at: "2026-08-01T00:05:00Z",
  schema_version: 1,
};

describe("LiveHub", () => {
  it("broadcasts a reading frame to every connected client", () => {
    const hub = new LiveHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.add(a as never);
    hub.add(b as never);

    hub.broadcastReading(reading);

    expect(JSON.parse(a.sent[0])).toEqual({ type: "reading", reading });
    expect(JSON.parse(b.sent[0])).toEqual({ type: "reading", reading });
  });

  it("stops delivering to a client once it has closed", () => {
    const hub = new LiveHub();
    const a = new FakeSocket();
    hub.add(a as never);
    a.emit("close");

    hub.broadcastReading(reading);

    expect(a.sent).toHaveLength(0);
  });

  it("closes a client whose buffered send amount exceeds 1 MiB with the overload code, and does not send to it", () => {
    const hub = new LiveHub();
    const slow = new FakeSocket();
    slow.bufferedAmount = 2 * 1024 * 1024;
    hub.add(slow as never);

    hub.broadcastReading(reading);

    expect(slow.sent).toHaveLength(0);
    expect(slow.closed).toEqual({ code: 1013, reason: "client send buffer exceeded 1 MiB" });
  });

  it("still delivers to a healthy client when another connected client is over its buffer bound", () => {
    const hub = new LiveHub();
    const slow = new FakeSocket();
    slow.bufferedAmount = 2 * 1024 * 1024;
    const healthy = new FakeSocket();
    hub.add(slow as never);
    hub.add(healthy as never);

    hub.broadcastReading(reading);

    expect(healthy.sent).toHaveLength(1);
  });

  it("broadcasts a heartbeat frame on the configured interval and stops once stopHeartbeat is called", () => {
    vi.useFakeTimers();
    try {
      const hub = new LiveHub();
      const a = new FakeSocket();
      hub.add(a as never);

      hub.startHeartbeat(1000);
      vi.advanceTimersByTime(1000);
      expect(a.sent).toHaveLength(1);
      expect(JSON.parse(a.sent[0])).toMatchObject({ type: "heartbeat" });

      hub.stopHeartbeat();
      vi.advanceTimersByTime(5000);
      expect(a.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closeAll closes every connected client with the server-shutdown code and stops the heartbeat", () => {
    vi.useFakeTimers();
    try {
      const hub = new LiveHub();
      const a = new FakeSocket();
      const b = new FakeSocket();
      hub.add(a as never);
      hub.add(b as never);
      hub.startHeartbeat(1000);

      hub.closeAll();

      expect(a.closed).toEqual({ code: 1001, reason: "server shutdown" });
      expect(b.closed).toEqual({ code: 1001, reason: "server shutdown" });

      vi.advanceTimersByTime(5000);
      expect(a.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
