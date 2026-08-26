"use client";

import { usePipelineHealth } from "@/hooks/use-pipeline-health";

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Not observed";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: "healthy" | "warning" | "neutral" }) {
  const toneClass = tone === "warning" ? "text-warning-base" : tone === "healthy" ? "text-success-base" : "text-text-strong-950";
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 px-4 py-3">
      <span className="text-subheading-xs text-text-soft-400 uppercase">{label}</span>
      <span className={`text-title-h4 tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

/**
 * The three real observability numbers from GET /pipeline-health, shown
 * plainly per docs/brand.md §4 — a status dot + explicit numbers, not
 * hidden in an admin-only page. A missing source stays "Not observed", not
 * a green/healthy zero (docs/tasks/TASK-live-dashboard.md §2.5.3).
 */
export function PipelineHealthSection() {
  const { data, isPending, isError, error } = usePipelineHealth();

  if (isPending) {
    return <p className="text-paragraph-sm text-text-sub-600">Loading pipeline health…</p>;
  }

  if (isError) {
    return <p className="text-paragraph-sm text-error-base">Pipeline health unavailable: {error instanceof Error ? error.message : "unknown error"}</p>;
  }

  return (
    <section aria-labelledby="pipeline-health-heading" className="flex flex-col gap-4">
      <h2 id="pipeline-health-heading" className="text-label-lg text-text-strong-950">
        Pipeline health
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard label="DLQ depth" value={String(data.dlqDepth)} tone={data.dlqDepth > 0 ? "warning" : "healthy"} />
        <StatCard label="Persist consumer lag" value={String(data.consumerLag)} tone={data.consumerLag > 0 ? "warning" : "healthy"} />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-subheading-sm text-text-sub-600 uppercase">Last successful poll</h3>
        <ul className="flex flex-col divide-y divide-stroke-soft-200 rounded-2xl border border-stroke-soft-200 bg-bg-white-0">
          {data.lastPollBySource.map((entry) => (
            <li key={entry.source} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="text-label-sm text-text-strong-950">{entry.source}</span>
              <span className={`text-paragraph-sm tabular-nums ${entry.lastSuccessAt ? "text-text-sub-600" : "text-error-base"}`}>
                {formatTimestamp(entry.lastSuccessAt)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
