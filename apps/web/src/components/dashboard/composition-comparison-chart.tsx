"use client";

import type { Metric } from "@renewable-pulse/contracts";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";
import { useGenerationMix } from "@/hooks/use-generation-mix";
import { ENTSOE_ZONES, ONS_ZONES } from "@/lib/zones";

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
 * The full generation-type breakdown for Brazil (ONS) vs USA (EIA) vs
 * Europe (ENTSO-E), each source's own units summed and normalized to % of
 * its own total before comparing — never adding MWmed to MAW/MWh. This is
 * a genuinely different, richer claim than the single hydro+wind+solar
 * share number in use-generation-share.ts: it shows the *whole*
 * composition, including where each grid's non-renewable share actually
 * comes from (US48 leans heavily thermal/nuclear, Brazil leans hydro,
 * Norway+Netherlands leans hydro+wind).
 */
export function CompositionComparisonChart({ visibleMetrics = METRIC_ORDER }: { visibleMetrics?: Metric[] }) {
  const { from, to } = useFixedDateRange(DAYS);
  const ons = useGenerationMix({ source: "ONS", zones: ONS_ZONES, from, to, bucket: "day" });
  const eia = useGenerationMix({ source: "EIA", zones: ["US-US48"], from, to, bucket: "day" });
  const entsoe = useGenerationMix({ source: "ENTSOE", zones: ENTSOE_ZONES, from, to, bucket: "day" });

  if (ons.isPending || eia.isPending || entsoe.isPending) {
    return <p className="text-paragraph-sm text-text-sub-600">Loading composition comparison…</p>;
  }
  if (ons.isError || eia.isError || entsoe.isError) {
    return <p className="text-paragraph-sm text-error-base">Composition comparison unavailable.</p>;
  }

  const rows: CountryRow[] = [];
  if (ons.data.rows.length > 0) rows.push(toPercentRow("Brazil (ONS)", ons.data.rows));
  if (eia.data.rows.length > 0) rows.push(toPercentRow("USA (EIA)", eia.data.rows));
  if (entsoe.data.rows.length > 0) rows.push(toPercentRow("Europe (ENTSO-E)", entsoe.data.rows));

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
          {METRIC_ORDER.filter((metric) => visibleMetrics.includes(metric)).map((metric) => (
            <Bar key={metric} dataKey={metric} stackId="mix" fill={`var(--color-${metric})`} radius={0} />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
