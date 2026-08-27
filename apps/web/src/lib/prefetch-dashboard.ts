import type { QueryClient } from "@tanstack/react-query";
import type { Zone } from "@renewable-pulse/contracts";
import { cachedDateRange } from "@/lib/cached-date-range";
import { generationLatestCache } from "@/lib/queries/generation-latest";
import { generationMixCache } from "@/lib/queries/generation-mix";
import { generationShareCache } from "@/lib/queries/generation-share";
import { generationTopAssetsCache } from "@/lib/queries/generation-top-assets";
import { plantsCache } from "@/lib/queries/plants";
import { ONS_ZONES, USA_REGIONAL_ZONES } from "@/lib/zones";

const US_US48: Zone[] = ["US-US48"];

/**
 * Prefetches, on the server, every query the dashboard's initial render
 * needs — so a visitor's first paint already has real data instead of a
 * loading state, and (via apiFetch's revalidateSeconds → Next's fetch Data
 * Cache) a *different* visitor within the same cache window gets that same
 * cached response instead of hitting apps/api again. Called once from
 * apps/app/page.tsx, which dehydrates the resulting QueryClient into a
 * HydrationBoundary.
 *
 * Every {from,to} here comes from cachedDateRange (not a raw `new Date()`)
 * so the query keys are byte-identical to what the client hooks compute for
 * the same `days` — required for hydration to actually be found rather than
 * silently refetched. This list intentionally covers every query a fresh
 * page load renders on first paint (dashboard-shell.tsx's default metric
 * filter, plant-map-section.tsx's default "ANEEL_SIGA" toggle, brazil/
 * usa-section's default states) — not every possible interaction (e.g. only
 * plant-leaderboard's default "hydro" metric, not all six).
 *
 * Deliberately excludes pipeline-health/-dlq/ingestion-throughput — those
 * stay always-live client-side fetches, matching apps/api's own
 * CACHEABLE_PATHS boundary (apps/api/src/cache-control.ts) exactly.
 */
export async function prefetchDashboardQueries(queryClient: QueryClient): Promise<void> {
  const share7 = cachedDateRange(7);
  const share30 = cachedDateRange(30);
  const mix14 = cachedDateRange(14);
  const mix7 = cachedDateRange(7);

  await Promise.all([
    // Brazil/USA deep-dive "current share" headline numbers
    queryClient.prefetchQuery(generationShareCache.options({ sources: ["ONS"], ...share7 })),
    queryClient.prefetchQuery(generationShareCache.options({ sources: ["EIA"], ...share7 })),
    // Country-comparison small multiples
    queryClient.prefetchQuery(generationShareCache.options({ sources: ["ONS", "ENTSOE", "EIA"], ...share30 })),

    // Brazil generation-mix-chart + regional-mix-chart (same key, dedupes)
    queryClient.prefetchQuery(generationMixCache.options({ source: "ONS", zones: ONS_ZONES, ...mix14, bucket: "day" })),
    // Brazil diurnal-pattern-chart + volatility-chart (same key, dedupes)
    queryClient.prefetchQuery(generationMixCache.options({ source: "ONS", zones: ONS_ZONES, ...mix7, bucket: "hour" })),
    // USA generation-mix-chart + composition-comparison-chart's EIA half (same key, dedupes)
    queryClient.prefetchQuery(generationMixCache.options({ source: "EIA", zones: US_US48, ...mix14, bucket: "day" })),
    // USA regional-mix-chart (different zones from the above — its own key)
    queryClient.prefetchQuery(generationMixCache.options({ source: "EIA", zones: USA_REGIONAL_ZONES, ...mix14, bucket: "day" })),
    // USA diurnal-pattern-chart + volatility-chart (same key, dedupes)
    queryClient.prefetchQuery(generationMixCache.options({ source: "EIA", zones: US_US48, ...mix7, bucket: "hour" })),

    // Brazil plant-leaderboard's default metric
    queryClient.prefetchQuery(generationTopAssetsCache.options({ metric: "hydro", ...mix14, limit: 10 })),

    // Plant registry — both toggle states (plant-map-section.tsx), cheap and hour-cached anyway
    queryClient.prefetchQuery(plantsCache.options("ANEEL_SIGA")),
    queryClient.prefetchQuery(plantsCache.options("EIA_860")),

    // Regional totals beside the map — both toggle states
    queryClient.prefetchQuery(generationLatestCache.options({ source: "ONS", zones: ONS_ZONES })),
    queryClient.prefetchQuery(generationLatestCache.options({ source: "EIA", zones: USA_REGIONAL_ZONES })),
  ]);
}
