"use client";

import type { Metric, Source, Zone } from "@renewable-pulse/contracts";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";
import { useGenerationMix } from "@/hooks/use-generation-mix";

const METRICS: Metric[] = ["hydro", "solar", "thermal", "wind"];

const chartConfig = {
  hydro: { label: "Hydro", color: "var(--chart-1)" },
  solar: { label: "Solar", color: "var(--chart-2)" },
  wind: { label: "Wind", color: "var(--chart-3)" },
  thermal: { label: "Thermal", color: "var(--chart-4)" },
} satisfies ChartConfig;

type HourRow = { hour: number } & Partial<Record<Metric, number>>;

/**
 * Sums across every requested zone per real hourly reading (same
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

/** Average real generation by UTC hour-of-day for one source, summed across every requested zone — the actual diurnal shape (solar peak, thermal evening ramp, hydro baseload) rather than a single daily average. */
export function DiurnalPatternChart({
  source,
  zones,
  label,
  days = 7,
  visibleMetrics = METRICS,
}: {
  source: Source;
  zones: Zone[];
  label: string;
  days?: number;
  visibleMetrics?: Metric[];
}) {
  const { from, to } = useFixedDateRange(days);
  const { data, isPending, isError, error } = useGenerationMix({ source, zones, from, to, bucket: "hour" });

  if (isPending) return <p className="text-paragraph-sm text-text-sub-600">Loading diurnal pattern…</p>;
  if (isError) {
    return <p className="text-paragraph-sm text-error-base">Diurnal pattern unavailable: {error instanceof Error ? error.message : "unknown error"}</p>;
  }
  if (data.rows.length === 0) return null;

  const rows = toDiurnalRows(data.rows);
  const unit = data.rows[0]?.unit ?? "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Average generation by hour of day ({unit})</h3>
        <span className="text-paragraph-xs text-text-soft-400">
          real hourly readings, averaged over the last {days} days, UTC, {label}
        </span>
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
        <LineChart data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="hour" tickFormatter={(h: number) => `${h}:00`} tickLine={false} axisLine={false} interval={2} />
          <YAxis tickLine={false} axisLine={false} width={48} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(h) => `${h}:00 UTC`} />} />
          {METRICS.filter((metric) => visibleMetrics.includes(metric)).map((metric) => (
            <Line key={metric} dataKey={metric} type="monotone" stroke={`var(--color-${metric})`} dot={false} strokeWidth={2} />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
