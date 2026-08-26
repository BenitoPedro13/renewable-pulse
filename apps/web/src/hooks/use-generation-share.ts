import { useQuery } from "@tanstack/react-query";
import { generationShareCache, type GenerationShareParams } from "@/lib/queries/generation-share";

/**
 * The exact, honest label for this metric (docs/tasks/TASK-live-dashboard.md
 * §2.1): `includedMetrics` is always exactly hydro+wind+solar, and thermal/
 * nuclear/other stay in the denominator only — this is not total renewable
 * share. Defined once here so every section that renders this number uses
 * the same words instead of each screen inventing its own paraphrase.
 */
export const GENERATION_SHARE_LABEL = "hydro + wind + solar share of observed generation";

/** Per-source, per-day hydro+wind+solar share for the country-comparison small multiples — GET /generation-share. */
export function useGenerationShare(params: GenerationShareParams) {
  return useQuery(generationShareCache.options(params));
}
