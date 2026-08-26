import { useQuery } from "@tanstack/react-query";
import { generationTopAssetsCache, type GenerationTopAssetsParams } from "@/lib/queries/generation-top-assets";

/** Top real ONS plants by average output for one fuel type over a window — GET /generation-top-assets. ONS only: EIA/ENTSO-E readings don't carry individual-plant granularity. */
export function useGenerationTopAssets(params: GenerationTopAssetsParams) {
  return useQuery(generationTopAssetsCache.options(params));
}
