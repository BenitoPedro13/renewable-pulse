import { useLiveStore } from "@/providers/live-store-provider";
import type { LiveConnectionStatus } from "@/stores/live-store";
import { useShallow } from "zustand/react/shallow";

export interface LiveConnectionInfo {
  status: LiveConnectionStatus;
  lastHeartbeatAt: string | null;
  /** Timestamp of the most recent real reading received over the socket — kept separate from heartbeats, which are connection metadata, not source data (docs/brand.md §4). */
  lastReadingAt: string | null;
}

/**
 * The live WebSocket connection's status and freshness, for the pulsing
 * live indicator. `useShallow` here isn't a perf tweak added after the
 * fact — it's the standard way to select a multi-field slice from a
 * Zustand store, so this hook doesn't re-render on every reading tick
 * (the `readings` map) when only these three fields are consumed.
 */
export function useLiveConnectionStatus(): LiveConnectionInfo {
  return useLiveStore(useShallow((s) => ({ status: s.status, lastHeartbeatAt: s.lastHeartbeatAt, lastReadingAt: s.lastReadingAt })));
}
