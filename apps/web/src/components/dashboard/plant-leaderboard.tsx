"use client";

import type { Metric } from "@renewable-pulse/contracts";
import { useState } from "react";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";
import { useGenerationTopAssets } from "@/hooks/use-generation-top-assets";

const RANKABLE_METRICS: Metric[] = ["hydro", "wind", "solar", "thermal", "nuclear", "other"];
const DAYS = 14;
const LIMIT = 10;

const METRIC_COLOR: Record<Metric, string> = {
  hydro: "var(--chart-1)",
  solar: "var(--chart-2)",
  wind: "var(--chart-3)",
  thermal: "var(--chart-4)",
  nuclear: "var(--chart-5)",
  other: "var(--chart-5)",
};

/**
 * Top real ONS plants by average output for one fuel type over the window
 * (docs/tasks/TASK-live-dashboard.md §2.7) — the plant-level granularity
 * the pipeline already ingests (readings.asset_id) but no other endpoint
 * surfaces (generation-mix/latest/share all aggregate it away). Ranks one
 * metric at a time by design — "top plants" mixing fuel types isn't a
 * meaningful single ranking.
 */
export function PlantLeaderboard() {
  const [metric, setMetric] = useState<Metric>("hydro");
  const { from, to } = useFixedDateRange(DAYS);
  const { data, isPending, isError, error } = useGenerationTopAssets({ metric, from, to, limit: LIMIT });

  const maxAvgValue = data?.rows[0]?.avgValue ?? 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Top real plants</h3>
        <span className="text-paragraph-xs text-text-soft-400">by average output, last {DAYS} days</span>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Rank plants by generation type">
        {RANKABLE_METRICS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={m === metric}
            onClick={() => setMetric(m)}
            className={`rounded-full px-2.5 py-1 text-paragraph-xs capitalize ${
              m === metric ? "bg-primary-base text-static-white" : "bg-bg-weak-50 text-text-sub-600"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {isPending ? <p className="text-paragraph-sm text-text-sub-600">Loading…</p> : null}
      {isError ? (
        <p className="text-paragraph-sm text-error-base">Top plants unavailable: {error instanceof Error ? error.message : "unknown error"}</p>
      ) : null}
      {!isPending && !isError && data.rows.length === 0 ? (
        <p className="text-paragraph-sm text-text-soft-400">No real {metric} readings in the last {DAYS} days.</p>
      ) : null}

      {!isPending && !isError && data.rows.length > 0 ? (
        <ol className="flex flex-col gap-1.5">
          {data.rows.map((row, index) => (
            <li key={row.assetId} className="flex items-center gap-3">
              <span className="w-5 text-right text-paragraph-xs tabular-nums text-text-soft-400">{index + 1}</span>
              <div className="flex flex-1 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-paragraph-sm text-text-strong-950">
                    {row.assetId} <span className="text-text-soft-400">({row.zone})</span>
                  </span>
                  <span className="text-paragraph-xs tabular-nums text-text-sub-600">
                    {Math.round(row.avgValue).toLocaleString()} {row.unit}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-bg-weak-50">
                  <div
                    className="h-1.5 rounded-full"
                    style={{ width: `${maxAvgValue > 0 ? (row.avgValue / maxAvgValue) * 100 : 0}%`, backgroundColor: METRIC_COLOR[metric] }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
