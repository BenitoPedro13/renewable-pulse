"use client";

import type { Metric, Source, Zone } from "@renewable-pulse/contracts";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useGenerationMix } from "@/hooks/use-generation-mix";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";

const METRIC_ORDER: Metric[] = ["hydro", "wind", "solar", "thermal", "nuclear", "other"];

const chartConfig = {
  hydro: { label: "Hydro", color: "var(--chart-1)" },
  wind: { label: "Wind", color: "var(--chart-3)" },
  solar: { label: "Solar", color: "var(--chart-2)" },
  thermal: { label: "Thermal", color: "var(--chart-4)" },
  // Grouped with "other" on the same purple ramp per docs/brand.md §2 — both are the minor/leftover categorical slice.
  nuclear: { label: "Nuclear", color: "var(--chart-5)" },
  other: { label: "Other", color: "var(--chart-5)" },
} satisfies ChartConfig;

type ChartRow = { bucketStart: string } & Partial<Record<Metric, number>>;

/** Sums generation-mix rows across every requested zone (same source/unit, so summing is valid) into one row per bucket/metric, for Recharts' one-object-per-x-value shape. */
function toChartRows(rows: { bucketStart: string; metric: Metric; value: number }[]): ChartRow[] {
  const byBucket = new Map<string, ChartRow>();
  for (const row of rows) {
    const existing = byBucket.get(row.bucketStart) ?? { bucketStart: row.bucketStart };
    existing[row.metric] = (existing[row.metric] ?? 0) + row.value;
    byBucket.set(row.bucketStart, existing);
  }
  return Array.from(byBucket.values()).sort((a, b) => Date.parse(a.bucketStart) - Date.parse(b.bucketStart));
}

/**
 * Stacked-area generation mix for one source, summed across every requested
 * zone, preserving that source's own unit label per docs/tasks/
 * TASK-live-dashboard.md §2.1 — never mixed with another source's unit.
 * `visibleMetrics` comes from the shared MetricFilterControl
 * (DashboardShell) and only hides/shows series client-side — the query
 * itself still fetches every metric, so toggling the filter never refetches.
 */
export function GenerationMixChart({
  source,
  zones,
  label,
  days = 14,
  visibleMetrics = METRIC_ORDER,
}: {
  source: Source;
  zones: Zone[];
  label: string;
  days?: number;
  visibleMetrics?: Metric[];
}) {
  const { from, to } = useFixedDateRange(days);
  const { data, isPending, isError, error } = useGenerationMix({ source, zones, from, to, bucket: "day" });

  if (isPending) {
    return <p className="text-paragraph-sm text-text-sub-600">Loading generation mix…</p>;
  }

  if (isError) {
    return (
      <p className="text-paragraph-sm text-error-base">
        Generation mix unavailable: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }

  if (data.rows.length === 0) {
    return <p className="text-paragraph-sm text-text-soft-400">No real {source} readings in the last {days} days.</p>;
  }

  const unit = data.rows[0]?.unit ?? "";
  const chartRows = toChartRows(data.rows);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Generation mix ({unit})</h3>
        <span className="text-paragraph-xs text-text-soft-400">
          last {days} days, {label}
        </span>
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
        <AreaChart data={chartRows}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="bucketStart"
            tickFormatter={(value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(value) => new Date(value as string).toLocaleDateString()} />} />
          {METRIC_ORDER.filter((metric) => visibleMetrics.includes(metric)).map((metric) => (
            <Area
              key={metric}
              dataKey={metric}
              type="monotone"
              stackId="mix"
              fill={`var(--color-${metric})`}
              stroke={`var(--color-${metric})`}
              fillOpacity={0.6}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
