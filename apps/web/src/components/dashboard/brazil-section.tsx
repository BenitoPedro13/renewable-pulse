"use client";

import { GENERATION_SHARE_LABEL, useGenerationShare } from "@/hooks/use-generation-share";
import { useGenerationLatest } from "@/hooks/use-generation-latest";
import { useState } from "react";
import { GenerationMixChart } from "@/components/dashboard/generation-mix-chart";
import { PlantMap } from "@/components/dashboard/plant-map";

function useDateRange(days: number) {
  const [range] = useState(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  });
  return range;
}

function CurrentShare() {
  const { from, to } = useDateRange(7);
  const { data, isPending } = useGenerationShare({ sources: ["ONS"], from, to });
  const latest = data?.rows.at(-1);

  if (isPending) return null;
  if (!latest) return <p className="text-paragraph-sm text-text-soft-400">No verified readings yet</p>;

  return (
    <div className="flex items-baseline gap-2">
      <span className="text-title-h2 tabular-nums text-primary-base">{Math.round(latest.share * 100)}%</span>
      <span className="text-paragraph-sm text-text-sub-600">{GENERATION_SHARE_LABEL}</span>
    </div>
  );
}

/** Current per-subsystem totals from GET /generation-latest — the latest real reading per (zone, asset_id, metric), summed to one total per subsystem. Not a live per-plant value (docs/tasks/TASK-live-dashboard.md §2.5.1). */
function SubsystemTotals() {
  const { data, isPending, isError } = useGenerationLatest();

  if (isPending) return <p className="text-paragraph-sm text-text-sub-600">Loading subsystem totals…</p>;
  if (isError || !data) return null;

  const totalsByZone = new Map<string, { total: number; latestAt: string }>();
  for (const reading of data.readings) {
    const existing = totalsByZone.get(reading.zone) ?? { total: 0, latestAt: reading.recorded_at };
    existing.total += reading.value;
    if (Date.parse(reading.recorded_at) > Date.parse(existing.latestAt)) existing.latestAt = reading.recorded_at;
    totalsByZone.set(reading.zone, existing);
  }

  return (
    <ul className="flex flex-col divide-y divide-stroke-soft-200 rounded-2xl border border-stroke-soft-200 bg-bg-white-0">
      {Array.from(totalsByZone.entries()).map(([zone, { total, latestAt }]) => (
        <li key={zone} className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="text-label-sm text-text-strong-950">{zone}</span>
          <span className="text-paragraph-sm tabular-nums text-text-sub-600">
            {Math.round(total).toLocaleString()} MWmed · {new Date(latestAt).toLocaleTimeString(undefined, { timeStyle: "short" })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BrazilSection() {
  return (
    <section aria-labelledby="brazil-heading" className="flex flex-col gap-4">
      <h2 id="brazil-heading" className="text-label-lg text-text-strong-950">
        Brazil deep-dive
      </h2>
      <CurrentShare />
      <GenerationMixChart />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PlantMap />
        <SubsystemTotals />
      </div>
    </section>
  );
}
