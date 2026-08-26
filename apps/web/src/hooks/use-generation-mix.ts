import { useQuery } from "@tanstack/react-query";
import { generationMixCache, type GenerationMixParams } from "@/lib/queries/generation-mix";

/** Generation-mix rows for any single source — GET /generation-mix. Preserves that source's own unit (ONS=MWmed, EIA=MWh); never sums across units or sources. */
export function useGenerationMix(params: GenerationMixParams) {
  return useQuery(generationMixCache.options(params));
}
