"use client";

import type { Metric } from "@renewable-pulse/contracts";
import { DiurnalPatternChart } from "@/components/dashboard/diurnal-pattern-chart";
import { GenerationMixChart } from "@/components/dashboard/generation-mix-chart";
import { RegionalMixChart } from "@/components/dashboard/regional-mix-chart";
import { VolatilityChart } from "@/components/dashboard/volatility-chart";
import { GENERATION_SHARE_LABEL, useGenerationShare } from "@/hooks/use-generation-share";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";
import { ENTSOE_ZONES } from "@/lib/zones";

function CurrentShare() {
  const { from, to } = useFixedDateRange(7);
  const { data, isPending } = useGenerationShare({ sources: ["ENTSOE"], from, to });
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

/**
 * Europe deep-dive (Norway + Netherlands via ENTSO-E), mirroring
 * UsaSection (docs/tasks/TASK-live-dashboard.md §2.10). No plant map or
 * leaderboard here — unlike ANEEL_SIGA/EIA_860, there is no ENTSO-E plant
 * registry wired into GET /plants, and ENTSO-E's generation-per-type
 * readings carry no per-plant asset_id either. Adding either would mean
 * inventing an unverified data source, against this project's hard
 * constraint (no synthetic data).
 */
export function EuropeSection({ visibleMetrics }: { visibleMetrics: Metric[] }) {
  return (
    <section aria-labelledby="europe-heading" className="flex flex-col gap-4">
      <h2 id="europe-heading" className="text-label-lg text-text-strong-950">
        Europe deep-dive
      </h2>
      <CurrentShare />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GenerationMixChart source="ENTSOE" zones={ENTSOE_ZONES} label="Norway + Netherlands" visibleMetrics={visibleMetrics} />
        <RegionalMixChart source="ENTSOE" zones={ENTSOE_ZONES} label="bidding zone" visibleMetrics={visibleMetrics} />
      </div>
      <DiurnalPatternChart source="ENTSOE" zones={ENTSOE_ZONES} label="Norway + Netherlands" visibleMetrics={visibleMetrics} />
      <VolatilityChart source="ENTSOE" zones={ENTSOE_ZONES} />
    </section>
  );
}
