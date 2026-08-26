"use client";

import type { Source, Zone } from "@renewable-pulse/contracts";
import { useGenerationLatest } from "@/hooks/use-generation-latest";

/**
 * Current per-zone totals from GET /generation-latest — the latest real
 * reading per (source, zone, asset_id, metric), summed to one total per
 * zone. Not a live per-plant value (docs/tasks/TASK-live-dashboard.md
 * §2.5.1). Generalized (source/zones props, real per-reading `unit` instead
 * of a hardcoded "MWmed") so the same panel can show either ONS's Brazil
 * subsystems or EIA's USA RTO/ISO regions — previously this was Brazil-only
 * and kept showing ONS totals even when the adjacent map was toggled to USA
 * (docs/tasks/TASK-live-dashboard.md §2.9).
 */
export function RegionalTotals({ source, zones }: { source: Source; zones: Zone[] }) {
  const { data, isPending, isError } = useGenerationLatest({ source, zones });

  if (isPending) return <p className="text-paragraph-sm text-text-sub-600">Loading regional totals…</p>;
  if (isError || !data) return null;
  if (data.readings.length === 0) return <p className="text-paragraph-sm text-text-soft-400">No verified readings yet</p>;

  const totalsByZone = new Map<string, { total: number; unit: string; latestAt: string }>();
  for (const reading of data.readings) {
    const existing = totalsByZone.get(reading.zone) ?? { total: 0, unit: reading.unit, latestAt: reading.recorded_at };
    existing.total += reading.value;
    if (Date.parse(reading.recorded_at) > Date.parse(existing.latestAt)) existing.latestAt = reading.recorded_at;
    totalsByZone.set(reading.zone, existing);
  }

  return (
    <ul className="flex flex-col divide-y divide-stroke-soft-200 rounded-2xl border border-stroke-soft-200 bg-bg-white-0">
      {Array.from(totalsByZone.entries()).map(([zone, { total, unit, latestAt }]) => (
        <li key={zone} className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="text-label-sm text-text-strong-950">{zone}</span>
          <span className="text-paragraph-sm tabular-nums text-text-sub-600">
            {Math.round(total).toLocaleString()} {unit} · {new Date(latestAt).toLocaleTimeString(undefined, { timeStyle: "short" })}
          </span>
        </li>
      ))}
    </ul>
  );
}
