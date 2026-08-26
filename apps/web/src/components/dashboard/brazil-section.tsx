"use client";

import type { Metric } from "@renewable-pulse/contracts";
import { GENERATION_SHARE_LABEL, useGenerationShare } from "@/hooks/use-generation-share";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";
import { DiurnalPatternChart } from "@/components/dashboard/diurnal-pattern-chart";
import { GenerationMixChart } from "@/components/dashboard/generation-mix-chart";
import { PlantLeaderboard } from "@/components/dashboard/plant-leaderboard";
import { RegionalMixChart } from "@/components/dashboard/regional-mix-chart";
import { VolatilityChart } from "@/components/dashboard/volatility-chart";
import { ONS_ZONES } from "@/lib/zones";

function CurrentShare() {
  const { from, to } = useFixedDateRange(7);
  const { data, isPending } = useGenerationShare({ sources: ["ONS"], from, to });
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
 * The plant map + per-zone totals pairing moved out to its own top-level
 * PlantMapSection (docs/tasks/TASK-live-dashboard.md §2.9) — it toggles
 * between Brazil and USA, so it doesn't belong nested under this
 * Brazil-only heading.
 */
export function BrazilSection({ visibleMetrics }: { visibleMetrics: Metric[] }) {
  return (
    <section aria-labelledby="brazil-heading" className="flex flex-col gap-4">
      <h2 id="brazil-heading" className="text-label-lg text-text-strong-950">
        Brazil deep-dive
      </h2>
      <CurrentShare />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GenerationMixChart source="ONS" zones={ONS_ZONES} label="all subsystems" visibleMetrics={visibleMetrics} />
        <RegionalMixChart source="ONS" zones={ONS_ZONES} label="subsystem" visibleMetrics={visibleMetrics} />
      </div>
      <DiurnalPatternChart source="ONS" zones={ONS_ZONES} label="all subsystems" visibleMetrics={visibleMetrics} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PlantLeaderboard />
        <VolatilityChart source="ONS" zones={ONS_ZONES} />
      </div>
    </section>
  );
}
