import { liveFrameSchema, type LiveFrame, type ReadingEvent } from "@renewable-pulse/contracts";

export type LiveConnectionStatus = "connecting" | "live" | "stale" | "closed";

export interface LiveClientHandlers {
  onStatusChange: (status: LiveConnectionStatus) => void;
  onHeartbeat: (sentAt: string) => void;
  onReading: (reading: ReadingEvent) => void;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * apps/api sends a heartbeat every LIVE_HEARTBEAT_MS (.env.example default
 * 30000ms). Treat the connection as stale after missing roughly two of
 * them, not the first delayed frame — real network jitter shouldn't flip
 * the live indicator.
 */
const STALE_AFTER_MS = 60_000;
const STALE_CHECK_INTERVAL_MS = 5_000;

/**
 * Owns the /live WebSocket connection: opens it, reconnects with bounded
 * exponential backoff on close, detects a stale (heartbeat-timed-out)
 * connection without necessarily being closed, and validates every frame
 * against packages/contracts' liveFrameSchema before forwarding it —
 * matching apps/api's own "every consumed payload is validated" rule
 * (docs/tasks/TASK-live-dashboard.md §2.3). A malformed frame is dropped,
 * not surfaced as a reading.
 *
 * Framework-agnostic on purpose (no Zustand/React import): the Context
 * provider that owns this instance (src/providers/live-client-provider.tsx)
 * wires its handlers to the Zustand store, per CLAUDE.md's "Context is for
 * a stable service instance, Zustand is for the state that changes on every
 * tick" split.
 */
export class LiveClient {
  private socket: WebSocket | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;
  private closedByCaller = false;

  constructor(
    private readonly url: string,
    private readonly handlers: LiveClientHandlers,
  ) {}

  connect(): void {
    this.closedByCaller = false;
    this.open();
  }

  disconnect(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopStaleCheck();
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    this.handlers.onStatusChange("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.lastActivityAt = Date.now();
      this.handlers.onStatusChange("live");
      this.startStaleCheck();
    });

    socket.addEventListener("message", (event) => {
      const parsed = liveFrameSchema.safeParse(JSON.parse(event.data as string));
      if (!parsed.success) return;
      this.lastActivityAt = Date.now();
      this.handlers.onStatusChange("live");
      this.dispatch(parsed.data);
    });

    socket.addEventListener("close", () => {
      this.stopStaleCheck();
      this.handlers.onStatusChange("closed");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private dispatch(frame: LiveFrame): void {
    if (frame.type === "heartbeat") this.handlers.onHeartbeat(frame.sentAt);
    else this.handlers.onReading(frame.reading);
  }

  private startStaleCheck(): void {
    this.stopStaleCheck();
    this.staleCheckTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt > STALE_AFTER_MS) this.handlers.onStatusChange("stale");
    }, STALE_CHECK_INTERVAL_MS);
  }

  private stopStaleCheck(): void {
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    this.staleCheckTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      this.open();
    }, this.reconnectDelayMs);
  }
}
