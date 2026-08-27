"use client";

import type { Metric } from "@renewable-pulse/contracts";
import { useState } from "react";
import { BrazilSection } from "@/components/dashboard/brazil-section";
import { CountryComparisonSection } from "@/components/dashboard/country-comparison-section";
import { EuropeSection } from "@/components/dashboard/europe-section";
import { ALL_METRICS, MetricFilterControl } from "@/components/dashboard/metric-filter-control";
import { PipelineHealthSection } from "@/components/dashboard/pipeline-health-section";
import { PipelineTransparencySection } from "@/components/dashboard/pipeline-transparency-section";
import { PlantMapSection } from "@/components/dashboard/plant-map-section";
import { UsaSection } from "@/components/dashboard/usa-section";

/**
 * Owns the shared metric filter (plain useState, per CLAUDE.md's state
 * conventions — this changes only on a user click, not every tick, so it
 * doesn't earn a Zustand store) and threads it as a prop into every chart
 * section. page.tsx stays a Server Component; this is the one client
 * boundary that needs to hold state shared across sibling sections.
 */
export function DashboardShell() {
  const [visibleMetrics, setVisibleMetrics] = useState<Metric[]>(ALL_METRICS);

  function toggleMetric(metric: Metric) {
    setVisibleMetrics((current) => (current.includes(metric) ? current.filter((m) => m !== metric) : [...current, metric]));
  }

  return (
    <div className="flex flex-col gap-8">
      <MetricFilterControl visible={visibleMetrics} onToggle={toggleMetric} />
      <BrazilSection visibleMetrics={visibleMetrics} />
      <UsaSection visibleMetrics={visibleMetrics} />
      <EuropeSection visibleMetrics={visibleMetrics} />
      <PlantMapSection />
      <CountryComparisonSection visibleMetrics={visibleMetrics} />
      <PipelineHealthSection />
      <PipelineTransparencySection />
    </div>
  );
}
