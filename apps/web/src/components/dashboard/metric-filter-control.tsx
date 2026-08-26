"use client";

import type { Metric } from "@renewable-pulse/contracts";

export const ALL_METRICS: Metric[] = ["hydro", "wind", "solar", "thermal", "nuclear", "other"];

const METRIC_COLOR: Record<Metric, string> = {
  hydro: "var(--chart-1)",
  solar: "var(--chart-2)",
  wind: "var(--chart-3)",
  thermal: "var(--chart-4)",
  nuclear: "var(--chart-5)",
  other: "var(--chart-5)",
};

/**
 * A shared metric filter, lifted with plain useState in DashboardShell and
 * passed as props (CLAUDE.md's state conventions: this changes only on a
 * user click, not every tick, so it doesn't earn a Zustand store or even a
 * Context — a couple of levels of prop drilling stays boring here).
 * Applies across every chart on the page at once.
 */
export function MetricFilterControl({ visible, onToggle }: { visible: Metric[]; onToggle: (metric: Metric) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter charts by generation type">
      {ALL_METRICS.map((metric) => {
        const isVisible = visible.includes(metric);
        return (
          <button
            key={metric}
            type="button"
            aria-pressed={isVisible}
            onClick={() => onToggle(metric)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-paragraph-xs capitalize transition-opacity ${
              isVisible ? "border-stroke-soft-200 bg-bg-white-0 text-text-strong-950" : "border-stroke-soft-200 bg-bg-weak-50 text-text-soft-400 opacity-60"
            }`}
          >
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: METRIC_COLOR[metric] }} />
            {metric}
          </button>
        );
      })}
    </div>
  );
}
