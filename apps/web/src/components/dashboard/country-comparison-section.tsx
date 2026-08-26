"use client";

import type { GenerationShareResponse, Source } from "@renewable-pulse/contracts";
import { useState } from "react";
import { GENERATION_SHARE_LABEL, useGenerationShare } from "@/hooks/use-generation-share";

// GET /generation-share is scoped per source, not per zone, so this panel
// is genuinely "Europe" once ENTSO-E is live: Norway's five bidding zones
// and the Netherlands' one zone (packages/contracts/src/event.ts) both feed
// the same ENTSOE source bucket in MAW. Splitting this into per-country
// panels would need a zone-scoped share endpoint, which doesn't exist yet.
const COUNTRIES: { source: Source; country: string; grid: string }[] = [
  { source: "ONS", country: "Brazil", grid: "ONS" },
  { source: "ENTSOE", country: "Europe (Norway + Netherlands)", grid: "ENTSO-E" },
  { source: "EIA", country: "USA", grid: "EIA" },
];

/** Last 30 days is enough to find the most recent real daily share per source without an unbounded query; fixed once per mount so the query key (and cache) stays stable across re-renders. */
function useDateRange(days: number) {
  const [range] = useState(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  });
  return range;
}

function latestRowFor(rows: GenerationShareResponse["rows"], source: Source) {
  return rows
    .filter((row) => row.source === source)
    .reduce<GenerationShareResponse["rows"][number] | undefined>((latest, row) => {
      if (!latest || Date.parse(row.bucketStart) > Date.parse(latest.bucketStart)) return row;
      return latest;
    }, undefined);
}

function CountryCard({ country, grid, row }: { country: string; grid: string; row: ReturnType<typeof latestRowFor> }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label-md text-text-strong-950">{country}</h3>
        <span className="text-subheading-2xs text-text-soft-400 uppercase">{grid}</span>
      </div>
      {row ? (
        <>
          <span className="text-title-h3 tabular-nums text-primary-base">{Math.round(row.share * 100)}%</span>
          <span className="text-paragraph-xs text-text-sub-600">
            {GENERATION_SHARE_LABEL} · {new Date(row.bucketStart).toLocaleDateString()} · {row.unit}
          </span>
        </>
      ) : (
        <span className="text-paragraph-sm text-text-soft-400">No verified readings yet</span>
      )}
    </div>
  );
}

/**
 * Three small multiples, not one combined chart (docs/brand.md §4): each
 * panel is source-scoped, so a Brazil/ONS MWmed share is never added to a
 * Norway/ENTSO-E MAW share. Until ENTSO-E is live-verified, its panel
 * renders "No verified readings yet" rather than a placeholder series
 * (docs/tasks/TASK-live-dashboard.md §2.5.2).
 */
export function CountryComparisonSection() {
  const { from, to } = useDateRange(30);
  const { data, isPending, isError, error } = useGenerationShare({ sources: ["ONS", "ENTSOE", "EIA"], from, to });

  if (isPending) {
    return <p className="text-paragraph-sm text-text-sub-600">Loading country comparison…</p>;
  }

  if (isError) {
    return (
      <p className="text-paragraph-sm text-error-base">
        Country comparison unavailable: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }

  return (
    <section aria-labelledby="country-comparison-heading" className="flex flex-col gap-4">
      <h2 id="country-comparison-heading" className="text-label-lg text-text-strong-950">
        Country comparison
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {COUNTRIES.map(({ source, country, grid }) => (
          <CountryCard key={source} country={country} grid={grid} row={latestRowFor(data.rows, source)} />
        ))}
      </div>
    </section>
  );
}
