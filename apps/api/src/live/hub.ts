import type { LiveFrame, ReadingEvent } from "@renewable-pulse/contracts";
import type WebSocket from "ws";

const MAX_BUFFERED_BYTES = 1024 * 1024;
const OVERLOAD_CLOSE = 1013;

export class LiveHub {
  private readonly clients = new Set<WebSocket>();
  private heartbeatTimer?: NodeJS.Timeout;

  add(client: WebSocket): void {
    this.clients.add(client);
    client.once("close", () => this.clients.delete(client));
  }

  broadcastReading(reading: ReadingEvent): void {
    this.broadcast({ type: "reading", reading });
  }

  startHeartbeat(intervalMs = 30000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.broadcast({ type: "heartbeat", sentAt: new Date().toISOString() }), intervalMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  closeAll(code = 1001, reason = "server shutdown"): void {
    this.stopHeartbeat();
    for (const client of this.clients) client.close(code, reason);
    this.clients.clear();
  }

  private broadcast(frame: LiveFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of this.clients) {
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.close(OVERLOAD_CLOSE, "client send buffer exceeded 1 MiB");
        this.clients.delete(client);
        continue;
      }
      client.send(payload);
    }
  }
}
