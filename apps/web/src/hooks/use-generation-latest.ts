import { useQuery } from "@tanstack/react-query";
import { generationLatestCache, type GenerationLatestParams } from "@/lib/queries/generation-latest";

/** Latest real ONS reading per (zone, asset_id, metric) — GET /generation-latest. No interpolation, no carry-forward beyond the latest row. */
export function useGenerationLatest(params: GenerationLatestParams = {}) {
  return useQuery(generationLatestCache.options(params));
}
