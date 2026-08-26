"use client";

import type { Metric } from "@renewable-pulse/contracts";
import { DiurnalPatternChart } from "@/components/dashboard/diurnal-pattern-chart";
import { GenerationMixChart } from "@/components/dashboard/generation-mix-chart";
import { GENERATION_SHARE_LABEL, useGenerationShare } from "@/hooks/use-generation-share";
import { useFixedDateRange } from "@/hooks/use-fixed-date-range";

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
 * USA deep-dive, mirroring Brazil's section (§2.7 in
 * docs/tasks/TASK-live-dashboard.md) but scoped to EIA's single US48
 * national aggregate — a regional (balancing-authority-level) breakdown
 * like Brazil's five subsystems is explicitly deferred (needs new EIA
 * respondent ingestion, not built this session).
 */
export function UsaSection({ visibleMetrics }: { visibleMetrics: Metric[] }) {
  return (
    <section aria-labelledby="usa-heading" className="flex flex-col gap-4">
      <h2 id="usa-heading" className="text-label-lg text-text-strong-950">
        USA deep-dive
      </h2>
      <CurrentShare />
      <GenerationMixChart source="EIA" zones={["US-US48"]} label="US48 national aggregate" visibleMetrics={visibleMetrics} />
      <DiurnalPatternChart source="EIA" zones={["US-US48"]} label="US48 national aggregate" visibleMetrics={visibleMetrics} />
    </section>
  );
}
