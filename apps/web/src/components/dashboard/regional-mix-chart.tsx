"use client";

import type { Metric, Source, Zone } from "@renewable-pulse/contracts";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";
import { useGenerationMix } from "@/hooks/use-generation-mix";

const DAYS = 14;

const METRIC_ORDER: Metric[] = ["hydro", "wind", "solar", "thermal", "nuclear", "other"];

const chartConfig = {
  hydro: { label: "Hydro", color: "var(--chart-1)" },
  wind: { label: "Wind", color: "var(--chart-3)" },
  solar: { label: "Solar", color: "var(--chart-2)" },
  thermal: { label: "Thermal", color: "var(--chart-4)" },
  nuclear: { label: "Nuclear", color: "var(--chart-5)" },
  other: { label: "Other", color: "var(--chart-5)" },
} satisfies ChartConfig;

type ZoneRow = { zone: string } & Partial<Record<Metric, number>>;

/** Sums each zone's rows to a total per metric over the window, then converts to a percentage of that zone's own total — real regional composition, not a national average that hides it. */
function toZonePercentRows(rows: { zone: string; metric: Metric; value: number }[]): ZoneRow[] {
  const totalsByZone = new Map<string, Partial<Record<Metric, number>>>();
  for (const row of rows) {
    const totals = totalsByZone.get(row.zone) ?? {};
    totals[row.metric] = (totals[row.metric] ?? 0) + row.value;
    totalsByZone.set(row.zone, totals);
  }
  return Array.from(totalsByZone.entries()).map(([zone, totals]) => {
    const sum = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
    const percentages: ZoneRow = { zone };
    for (const metric of METRIC_ORDER) {
      const value = totals[metric];
      if (value !== undefined && sum > 0) percentages[metric] = (value / sum) * 100;
    }
    return percentages;
  });
}

/**
 * Each region within a source has a genuinely different generation mix
 * (ONS's Amazon-heavy North subsystem is almost entirely hydro while its
 * Northeast has far more wind; EIA's ISO New England leans nuclear/gas while
 * SWPP leans wind) — a national/source-wide total hides that. One
 * 100%-stacked bar per zone, in % rather than raw source units, makes the
 * regional comparison direct. Generalized (source/zones/label props) so
 * Brazil's and USA's regional charts share one component
 * (docs/tasks/TASK-live-dashboard.md §2.7/§2.8) instead of duplicating a
 * per-country file.
 */
export function RegionalMixChart({
  source,
  zones,
  label,
  visibleMetrics = METRIC_ORDER,
}: {
  source: Source;
  zones: Zone[];
  label: string;
  visibleMetrics?: Metric[];
}) {
  const { from, to } = useFixedDateRange(DAYS);
  const { data, isPending, isError, error } = useGenerationMix({ source, zones, from, to, bucket: "day" });

  if (isPending) return <p className="text-paragraph-sm text-text-sub-600">Loading regional mix…</p>;
  if (isError) {
    return <p className="text-paragraph-sm text-error-base">Regional mix unavailable: {error instanceof Error ? error.message : "unknown error"}</p>;
  }
  if (data.rows.length === 0) return null;

  const rows = toZonePercentRows(data.rows).sort((a, b) => a.zone.localeCompare(b.zone));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Generation mix by region</h3>
        <span className="text-paragraph-xs text-text-soft-400">% of {label} total, last {DAYS} days</span>
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
        <BarChart data={rows} layout="vertical" margin={{ left: 8 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="zone" tickLine={false} axisLine={false} width={56} />
          <ChartTooltip content={<ChartTooltipContent formatter={(value) => `${Number(value).toFixed(1)}%`} />} />
          {METRIC_ORDER.filter((metric) => visibleMetrics.includes(metric)).map((metric) => (
            <Bar key={metric} dataKey={metric} stackId="mix" fill={`var(--color-${metric})`} radius={0} />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
