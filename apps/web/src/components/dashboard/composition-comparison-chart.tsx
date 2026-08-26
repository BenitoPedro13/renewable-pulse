"use client";

import type { Metric, Zone } from "@renewable-pulse/contracts";
import { zoneSchema } from "@renewable-pulse/contracts";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useGenerationMix } from "@/hooks/use-generation-mix";

const ONS_ZONES = zoneSchema.options.filter((zone): zone is Zone & `BR-${string}` => zone.startsWith("BR-"));
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

function useDateRange(days: number) {
  const [range] = useState(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  });
  return range;
}

type CountryRow = { country: string } & Partial<Record<Metric, number>>;

function toPercentRow(country: string, rows: { metric: Metric; value: number }[]): CountryRow {
  const totals = new Map<Metric, number>();
  for (const row of rows) totals.set(row.metric, (totals.get(row.metric) ?? 0) + row.value);
  const sum = Array.from(totals.values()).reduce((a, b) => a + b, 0);
  const result: CountryRow = { country };
  for (const [metric, value] of totals) if (sum > 0) result[metric] = (value / sum) * 100;
  return result;
}

/**
 * The full generation-type breakdown for Brazil (ONS) vs USA (EIA), each
 * source's own units summed and normalized to % of its own total before
 * comparing — never adding MWmed to MWh. This is a genuinely different,
 * richer claim than the single hydro+wind+solar share number in
 * use-generation-share.ts: it shows the *whole* composition, including
 * where each grid's non-renewable share actually comes from (US48 leans
 * heavily thermal/nuclear where Brazil leans hydro).
 */
export function CompositionComparisonChart() {
  const { from, to } = useDateRange(DAYS);
  const ons = useGenerationMix({ zones: ONS_ZONES, from, to, bucket: "day" });
  const eia = useGenerationMix({ zones: ["US-US48"], from, to, bucket: "day" });

  if (ons.isPending || eia.isPending) return <p className="text-paragraph-sm text-text-sub-600">Loading composition comparison…</p>;
  if (ons.isError || eia.isError) {
    return <p className="text-paragraph-sm text-error-base">Composition comparison unavailable.</p>;
  }

  const rows: CountryRow[] = [];
  if (ons.data.rows.length > 0) rows.push(toPercentRow("Brazil (ONS)", ons.data.rows));
  if (eia.data.rows.length > 0) rows.push(toPercentRow("USA (EIA)", eia.data.rows));

  if (rows.length === 0) return <p className="text-paragraph-sm text-text-soft-400">No verified readings yet</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Full generation-type composition</h3>
        <span className="text-paragraph-xs text-text-soft-400">% of each grid&apos;s own total, last {DAYS} days</span>
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
        <BarChart data={rows} layout="vertical" margin={{ left: 8 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="country" tickLine={false} axisLine={false} width={88} />
          <ChartTooltip content={<ChartTooltipContent formatter={(value) => `${Number(value).toFixed(1)}%`} />} />
          {METRIC_ORDER.map((metric) => (
            <Bar key={metric} dataKey={metric} stackId="mix" fill={`var(--color-${metric})`} radius={0} />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
