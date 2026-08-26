"use client";

import type { Metric, Zone } from "@renewable-pulse/contracts";
import { zoneSchema } from "@renewable-pulse/contracts";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useGenerationMix } from "@/hooks/use-generation-mix";

const ONS_ZONES = zoneSchema.options.filter((zone): zone is Zone & `BR-${string}` => zone.startsWith("BR-"));
const DAYS = 7;
const METRICS: Metric[] = ["hydro", "solar", "thermal", "wind"];

const chartConfig = {
  hydro: { label: "Hydro", color: "var(--chart-1)" },
  solar: { label: "Solar", color: "var(--chart-2)" },
  wind: { label: "Wind", color: "var(--chart-3)" },
  thermal: { label: "Thermal", color: "var(--chart-4)" },
} satisfies ChartConfig;

function useDateRange(days: number) {
  const [range] = useState(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  });
  return range;
}

type HourRow = { hour: number } & Partial<Record<Metric, number>>;

/**
 * Sums across the five ONS subsystems per real hourly reading (same
 * source/unit), then averages by UTC hour-of-day across every day in the
 * window — a real diurnal shape (solar's midday peak, thermal's evening
 * ramp as solar drops, hydro's flat baseload), not a smoothed/synthetic
 * curve. Each point is the mean of real observed hours, so a sparse hour
 * still reflects only real readings.
 */
function toDiurnalRows(rows: { bucketStart: string; metric: Metric; value: number }[]): HourRow[] {
  const totalsByHourOfDay = new Map<number, Partial<Record<Metric, { sum: number; count: number }>>>();
  const seenTimestampMetric = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.bucketStart}|${row.metric}`;
    seenTimestampMetric.set(key, (seenTimestampMetric.get(key) ?? 0) + row.value);
  }
  for (const [key, summedAcrossZones] of seenTimestampMetric) {
    const [bucketStart, metric] = key.split("|") as [string, Metric];
    const hourOfDay = new Date(bucketStart).getUTCHours();
    const perHour = totalsByHourOfDay.get(hourOfDay) ?? {};
    const entry = perHour[metric] ?? { sum: 0, count: 0 };
    entry.sum += summedAcrossZones;
    entry.count += 1;
    perHour[metric] = entry;
    totalsByHourOfDay.set(hourOfDay, perHour);
  }
  return Array.from({ length: 24 }, (_, hour) => {
    const perHour = totalsByHourOfDay.get(hour) ?? {};
    const row: HourRow = { hour };
    for (const metric of METRICS) {
      const entry = perHour[metric];
      if (entry) row[metric] = entry.sum / entry.count;
    }
    return row;
  });
}

/** Average real generation by UTC hour-of-day, over the ONS subsystems combined — the actual diurnal shape (solar peak, thermal evening ramp, hydro baseload) rather than a single daily average. */
export function DiurnalPatternChart() {
  const { from, to } = useDateRange(DAYS);
  const { data, isPending, isError, error } = useGenerationMix({ zones: ONS_ZONES, from, to, bucket: "hour" });

  if (isPending) return <p className="text-paragraph-sm text-text-sub-600">Loading diurnal pattern…</p>;
  if (isError) {
    return <p className="text-paragraph-sm text-error-base">Diurnal pattern unavailable: {error instanceof Error ? error.message : "unknown error"}</p>;
  }
  if (data.rows.length === 0) return null;

  const rows = toDiurnalRows(data.rows);
  const unit = data.rows[0]?.unit ?? "MWmed";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Average generation by hour of day ({unit})</h3>
        <span className="text-paragraph-xs text-text-soft-400">real hourly readings, averaged over the last {DAYS} days, UTC</span>
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
        <LineChart data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="hour" tickFormatter={(h: number) => `${h}:00`} tickLine={false} axisLine={false} interval={2} />
          <YAxis tickLine={false} axisLine={false} width={48} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(h) => `${h}:00 UTC`} />} />
          {METRICS.map((metric) => (
            <Line key={metric} dataKey={metric} type="monotone" stroke={`var(--color-${metric})`} dot={false} strokeWidth={2} />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
