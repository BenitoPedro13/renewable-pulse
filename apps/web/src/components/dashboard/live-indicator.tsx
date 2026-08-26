"use client";

import { useLiveConnectionStatus } from "@/hooks/use-live-connection-status";

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  live: "Live",
  stale: "Stale",
  closed: "Disconnected",
};

/**
 * Pulses slowly only while the socket is connected and heartbeats are
 * current; the pulse itself carries no data meaning (color/text below do),
 * so it also respects reduced motion (docs/brand.md §4,
 * docs/tasks/TASK-live-dashboard.md §5.5).
 */
export function LiveIndicator() {
  const { status, lastReadingAt } = useLiveConnectionStatus();
  const dotClass = status === "live" ? "bg-success-base motion-safe:animate-pulse" : status === "stale" ? "bg-warning-base" : "bg-text-soft-400";

  return (
    <div className="flex items-center gap-2 text-paragraph-xs text-text-sub-600">
      <span aria-hidden className={`h-2 w-2 rounded-full ${dotClass}`} />
      <span>{STATUS_LABEL[status]}</span>
      {lastReadingAt ? (
        <span className="tabular-nums">
          · last reading {new Date(lastReadingAt).toLocaleTimeString(undefined, { timeStyle: "medium" })}
        </span>
      ) : null}
    </div>
  );
}
