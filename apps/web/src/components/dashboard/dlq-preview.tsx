"use client";

import { usePipelineDlq } from "@/hooks/use-pipeline-dlq";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/**
 * A real, read-only preview of readings.dlq — the actual malformed/
 * unknown-zone events the pipeline routed away from crashing the consumer
 * (docs/architecture.md §5, CLAUDE.md invariant 5), not a summary count.
 * Replay is intentionally not offered here; it stays a CLI-only action
 * (`pnpm --filter consumer dlq -- replay`) so this read-only dashboard route
 * can never trigger a mutating re-publish.
 */
export function DlqPreview() {
  const { data, isPending, isError, error } = usePipelineDlq(20);

  if (isPending) {
    return <p className="text-paragraph-sm text-text-sub-600">Loading DLQ preview…</p>;
  }

  if (isError) {
    return <p className="text-paragraph-sm text-error-base">DLQ preview unavailable: {error instanceof Error ? error.message : "unknown error"}</p>;
  }

  if (data.entries.length === 0) {
    return <p className="text-paragraph-sm text-success-base">readings.dlq is empty — no malformed events pending.</p>;
  }

  return (
    <ul className="flex flex-col divide-y divide-stroke-soft-200 rounded-2xl border border-stroke-soft-200 bg-bg-white-0">
      {data.entries.map((entry) => (
        <li key={`${entry.partition}-${entry.offset}`} className="flex flex-col gap-1 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-label-sm text-error-base">{entry.error}</span>
            <span className="text-paragraph-xs tabular-nums text-text-soft-400">{formatTimestamp(entry.failedAt)}</span>
          </div>
          <span className="text-paragraph-xs text-text-sub-600">source topic: {entry.sourceTopic}</span>
          <details className="text-paragraph-xs text-text-sub-600">
            <summary className="cursor-pointer text-text-soft-400">raw payload</summary>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-bg-weak-50 p-2 text-paragraph-xs">{JSON.stringify(entry.raw, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
