import { useQuery } from "@tanstack/react-query";
import { generationLatestCache, type GenerationLatestParams } from "@/lib/queries/generation-latest";

/** Latest real reading per (source, zone, asset_id, metric) for the requested source — GET /generation-latest. No interpolation, no carry-forward beyond the latest row. */
export function useGenerationLatest(params: GenerationLatestParams) {
  return useQuery(generationLatestCache.options(params));
}
