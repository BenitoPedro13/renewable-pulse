"use client";

import type { Metric } from "@renewable-pulse/contracts";
import { useState } from "react";
import { usePlants } from "@/hooks/use-plants";

const RANKABLE_METRICS: Metric[] = ["hydro", "wind", "solar", "thermal", "nuclear", "other"];
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
 * Top USA plants by *registered nameplate capacity*, not live output.
 * EIA's fuel-type-data (the hourly generation apps/ingest polls) is
 * respondent/zone-level only, with no per-generator readings, so a live-
 * output leaderboard like Brazil's PlantLeaderboard isn't possible for the
 * USA (docs/tasks/TASK-live-dashboard.md §2.9). This ranks the same real
 * EIA-860 registry data the USA plant map already fetches
 * (GET /plants?source=EIA_860, cached/shared via the same usePlants query)
 * by installedCapacityKw instead — a deliberately different metric from
 * Brazil's ranking, labeled as such rather than implied comparable.
 */
export function PlantCapacityLeaderboard() {
  const [metric, setMetric] = useState<Metric>("thermal");
  const { data, isPending, isError, error } = usePlants("EIA_860");

  const ranked =
    data && !data.unavailable
      ? data.plants
          .filter((p) => p.metric === metric && p.installedCapacityKw !== null)
          .sort((a, b) => (b.installedCapacityKw ?? 0) - (a.installedCapacityKw ?? 0))
          .slice(0, LIMIT)
      : [];
  const maxCapacityKw = ranked[0]?.installedCapacityKw ?? 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Top USA plants by registered capacity</h3>
        <span className="text-paragraph-xs text-text-soft-400">EIA-860 nameplate capacity, not live output</span>
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
      {!isPending && !isError && data?.unavailable ? (
        <p className="text-paragraph-sm text-error-base">EIA-860 registry is currently unreachable — no cached data available.</p>
      ) : null}
      {!isPending && !isError && !data?.unavailable && ranked.length === 0 ? (
        <p className="text-paragraph-sm text-text-soft-400">No real {metric} plants in the current EIA-860 sample.</p>
      ) : null}

      {ranked.length > 0 ? (
        <ol className="flex flex-col gap-1.5">
          {ranked.map((plant, index) => (
            <li key={plant.ceg} className="flex items-center gap-3">
              <span className="w-5 text-right text-paragraph-xs tabular-nums text-text-soft-400">{index + 1}</span>
              <div className="flex flex-1 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-paragraph-sm text-text-strong-950">
                    {plant.name || plant.ceg} <span className="text-text-soft-400">({plant.state})</span>
                  </span>
                  <span className="text-paragraph-xs tabular-nums text-text-sub-600">
                    {((plant.installedCapacityKw ?? 0) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} MW
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-bg-weak-50">
                  <div
                    className="h-1.5 rounded-full"
                    style={{
                      width: `${maxCapacityKw > 0 ? ((plant.installedCapacityKw ?? 0) / maxCapacityKw) * 100 : 0}%`,
                      backgroundColor: METRIC_COLOR[metric],
                    }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {data && !data.unavailable ? <p className="text-paragraph-xs text-text-soft-400">{data.attribution}</p> : null}
    </div>
  );
}
