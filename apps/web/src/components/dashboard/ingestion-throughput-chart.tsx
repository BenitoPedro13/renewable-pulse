"use client";

import type { Source } from "@renewable-pulse/contracts";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useIngestionThroughput } from "@/hooks/use-ingestion-throughput";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";

const SOURCE_ORDER: Source[] = ["ONS", "EIA", "ENTSOE"];

// Reuses the existing --chart-* tokens (no new hex) to distinguish the three
// ingestion sources — an arbitrary-but-consistent assignment, not tied to
// any metric meaning the way the hydro/wind/solar/thermal palette is.
const chartConfig = {
  ONS: { label: "ONS (Brazil)", color: "var(--chart-1)" },
  EIA: { label: "EIA (USA)", color: "var(--chart-2)" },
  ENTSOE: { label: "ENTSO-E (Norway)", color: "var(--chart-3)" },
} satisfies ChartConfig;

type ChartRow = { day: string } & Partial<Record<Source, number>>;

/** Rolls hourly reading_count rows up into one row per UTC day/source, for a legible 7-bar-group chart instead of 168 hourly ticks. */
function toDailyRows(rows: { bucketStart: string; source: Source; readingCount: number }[]): ChartRow[] {
  const byDay = new Map<string, ChartRow>();
  for (const row of rows) {
    const day = row.bucketStart.slice(0, 10);
    const existing = byDay.get(day) ?? { day };
    existing[row.source] = (existing[row.source] ?? 0) + row.readingCount;
    byDay.set(day, existing);
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Real hourly-persisted-reading counts per source, rolled up to daily bars —
 * the actual ingestion volume behind the pipeline's reliability story
 * (docs/tasks/TASK-pipeline-transparency-panel.md §2.2/§2.4), not a
 * decorative sparkline. A day with no real readings for a source is simply
 * absent from that day's bar, never a generated zero.
 */
export function IngestionThroughputChart({ days = 7 }: { days?: number }) {
  const { from, to } = useFixedDateRange(days);
  const { data, isPending, isError, error } = useIngestionThroughput({ from, to });

  if (isPending) {
    return <p className="text-paragraph-sm text-text-sub-600">Loading ingestion throughput…</p>;
  }

  if (isError) {
    return (
      <p className="text-paragraph-sm text-error-base">
        Ingestion throughput unavailable: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }

  if (data.rows.length === 0) {
    return <p className="text-paragraph-sm text-text-soft-400">No real readings persisted in the last {days} days.</p>;
  }

  const rows = toDailyRows(data.rows);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Ingestion throughput (real readings/day)</h3>
        <span className="text-paragraph-xs text-text-soft-400">last {days} days</span>
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
        <BarChart data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="day" tickFormatter={(value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })} tickLine={false} axisLine={false} />
          <YAxis tickLine={false} axisLine={false} width={40} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(value) => new Date(value as string).toLocaleDateString()} />} />
          <ChartLegend content={<ChartLegendContent />} />
          {SOURCE_ORDER.map((source) => (
            <Bar key={source} dataKey={source} fill={`var(--color-${source})`} radius={2} />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
