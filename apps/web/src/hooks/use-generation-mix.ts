import { useQuery } from "@tanstack/react-query";
import { generationMixCache, type GenerationMixParams } from "@/lib/queries/generation-mix";

/** ONS generation-mix rows for the Brazil stacked-area chart — GET /generation-mix. Preserves the source's own MWmed unit; never sums across units. */
export function useGenerationMix(params: GenerationMixParams) {
  return useQuery(generationMixCache.options(params));
}
