import type { ReadingEvent } from "@renewable-pulse/contracts";
import { createStore } from "zustand/vanilla";

export type LiveConnectionStatus = "connecting" | "live" | "stale" | "closed";

/** `source|zone|asset_id|metric` — the idempotency key fields from packages/contracts, minus recorded_at (this buffer holds one *latest* reading per series, not history). */
function readingBufferKey(reading: ReadingEvent): string {
  return `${reading.source}|${reading.zone}|${reading.asset_id ?? ""}|${reading.metric}`;
}

export type LiveState = {
  status: LiveConnectionStatus;
  lastHeartbeatAt: string | null;
  lastReadingAt: string | null;
  readings: ReadonlyMap<string, ReadingEvent>;
};

export type LiveActions = {
  setStatus: (status: LiveConnectionStatus) => void;
  recordHeartbeat: (sentAt: string) => void;
  recordReading: (reading: ReadingEvent) => void;
  reset: () => void;
};

export type LiveStore = LiveState & LiveActions;

export const defaultLiveState: LiveState = {
  status: "connecting",
  lastHeartbeatAt: null,
  lastReadingAt: null,
  readings: new Map(),
};

/**
 * Zustand's own Next.js App Router pattern (verified against
 * zustand.docs.pmnd.rs/learn/guides/nextjs, CLAUDE.md "Frontend state
 * conventions"): createStore from zustand/vanilla, instantiated per-provider
 * via useState in live-store-provider.tsx — never as a module-level global,
 * which would leak state across requests/users on the server.
 */
export function createLiveStore(initState: LiveState = defaultLiveState) {
  return createStore<LiveStore>()((set) => ({
    ...initState,
    setStatus: (status) => set({ status }),
    recordHeartbeat: (sentAt) => set({ lastHeartbeatAt: sentAt }),
    recordReading: (reading) =>
      set((state) => {
        const readings = new Map(state.readings);
        readings.set(readingBufferKey(reading), reading);
        const lastReadingAt =
          !state.lastReadingAt || Date.parse(reading.recorded_at) > Date.parse(state.lastReadingAt)
            ? reading.recorded_at
            : state.lastReadingAt;
        return { readings, lastReadingAt };
      }),
    reset: () => set(defaultLiveState),
  }));
}
