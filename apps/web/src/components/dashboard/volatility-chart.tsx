"use client";

import type { Metric, Source, Zone } from "@renewable-pulse/contracts";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";
import { useGenerationMix } from "@/hooks/use-generation-mix";

const METRICS: Metric[] = ["hydro", "wind", "solar", "thermal"];
const DAYS = 7;

const METRIC_COLOR: Record<Metric, string> = {
  hydro: "var(--chart-1)",
  solar: "var(--chart-2)",
  wind: "var(--chart-3)",
  thermal: "var(--chart-4)",
  nuclear: "var(--chart-5)",
  other: "var(--chart-5)",
};

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Coefficient of variation (stdev / mean) per metric, summed across every requested zone per real hourly reading first — a real, dimensionless measure of how much each fuel type's real hourly output swings, not just its average level. */
function toVolatilityRows(rows: { bucketStart: string; metric: Metric; value: number }[]) {
  const summedByTimestampMetric = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.bucketStart}|${row.metric}`;
    summedByTimestampMetric.set(key, (summedByTimestampMetric.get(key) ?? 0) + row.value);
  }
  const valuesByMetric = new Map<Metric, number[]>();
  for (const [key, value] of summedByTimestampMetric) {
    const metric = key.split("|")[1] as Metric;
    const list = valuesByMetric.get(metric) ?? [];
    list.push(value);
    valuesByMetric.set(metric, list);
  }
  return METRICS.map((metric) => {
    const values = valuesByMetric.get(metric) ?? [];
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const coefficientOfVariation = mean > 0 ? stddev(values) / mean : 0;
    return { metric, coefficientOfVariation, hasData: values.length > 0 };
  }).filter((r) => r.hasData);
}

/**
 * A real volatility signal computed from the same hourly readings the
 * diurnal-pattern chart uses — the coefficient of variation of real hourly
 * output per fuel type. Wind and solar's real intermittency should read as
 * far higher than hydro's real reservoir-smoothed baseload; this is a
 * genuine technical property of the observed data, not a synthetic
 * indicator.
 */
export function VolatilityChart({ source, zones, days = DAYS }: { source: Source; zones: Zone[]; days?: number }) {
  const { from, to } = useFixedDateRange(days);
  const { data, isPending, isError } = useGenerationMix({ source, zones, from, to, bucket: "hour" });

  if (isPending) return <p className="text-paragraph-sm text-text-sub-600">Loading volatility…</p>;
  if (isError || data.rows.length === 0) return null;

  const rows = toVolatilityRows(data.rows).sort((a, b) => b.coefficientOfVariation - a.coefficientOfVariation);
  const maxCv = rows[0]?.coefficientOfVariation ?? 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-sm text-text-strong-950">Hour-to-hour volatility</h3>
        <span className="text-paragraph-xs text-text-soft-400">coefficient of variation, last {days} days</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map(({ metric, coefficientOfVariation }) => (
          <li key={metric} className="flex items-center gap-3">
            <span className="w-16 text-paragraph-xs capitalize text-text-strong-950">{metric}</span>
            <div className="h-1.5 flex-1 rounded-full bg-bg-weak-50">
              <div
                className="h-1.5 rounded-full"
                style={{ width: `${maxCv > 0 ? (coefficientOfVariation / maxCv) * 100 : 0}%`, backgroundColor: METRIC_COLOR[metric] }}
              />
            </div>
            <span className="w-12 text-right text-paragraph-xs tabular-nums text-text-sub-600">{coefficientOfVariation.toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
