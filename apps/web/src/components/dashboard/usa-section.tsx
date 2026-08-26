"use client";

import type { Metric, Zone } from "@renewable-pulse/contracts";
import { DiurnalPatternChart } from "@/components/dashboard/diurnal-pattern-chart";
import { GenerationMixChart } from "@/components/dashboard/generation-mix-chart";
import { RegionalMixChart } from "@/components/dashboard/regional-mix-chart";
import { VolatilityChart } from "@/components/dashboard/volatility-chart";
import { GENERATION_SHARE_LABEL, useGenerationShare } from "@/hooks/use-generation-share";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";

// The seven RTO/ISO respondents added for regional depth
// (docs/tasks/TASK-live-dashboard.md §2.8) — deliberately excludes
// "US-US48", which is the sum of these regions (and others EIA does not
// break out), so it doesn't appear as one more "region" alongside the sums
// it already contains.
const USA_REGIONAL_ZONES: Zone[] = ["US-CISO", "US-ERCO", "US-ISNE", "US-MISO", "US-NYIS", "US-PJM", "US-SWPP"];

function CurrentShare() {
  const { from, to } = useFixedDateRange(7);
  const { data, isPending } = useGenerationShare({ sources: ["EIA"], from, to });
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
 * USA deep-dive, mirroring Brazil's section (§2.7/§2.8 in
 * docs/tasks/TASK-live-dashboard.md). The national mix/diurnal/volatility
 * charts stay scoped to EIA's US48 national aggregate, and the regional mix
 * chart below adds the seven-RTO breakdown ingested in §2.8 — a US regional
 * plant *map* (mirroring Brazil's) remains deferred pending a verified
 * balancing-authority field on EIA-860.
 */
export function UsaSection({ visibleMetrics }: { visibleMetrics: Metric[] }) {
  return (
    <section aria-labelledby="usa-heading" className="flex flex-col gap-4">
      <h2 id="usa-heading" className="text-label-lg text-text-strong-950">
        USA deep-dive
      </h2>
      <CurrentShare />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GenerationMixChart source="EIA" zones={["US-US48"]} label="US48 national aggregate" visibleMetrics={visibleMetrics} />
        <RegionalMixChart source="EIA" zones={USA_REGIONAL_ZONES} label="RTO/ISO" visibleMetrics={visibleMetrics} />
      </div>
      <DiurnalPatternChart source="EIA" zones={["US-US48"]} label="US48 national aggregate" visibleMetrics={visibleMetrics} />
      <VolatilityChart source="EIA" zones={["US-US48"]} />
    </section>
  );
}
