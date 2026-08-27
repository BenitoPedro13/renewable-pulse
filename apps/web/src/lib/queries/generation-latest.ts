import { generationLatestResponseSchema, type GenerationLatestResponse, type Source, type Zone } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

// source was originally hardcoded to "ONS"; required as a param instead
// (matching /generation-mix's widening, docs/tasks/TASK-live-dashboard.md
// §2.9) so the same query/hook can back either country's regional-totals
// panel — TypeScript then flags every call site that needs a source.
export interface GenerationLatestParams {
  source: Source;
  zones?: Zone[];
}

const REFETCH_INTERVAL_MS = 30_000;

export const generationLatestCache = {
  key: (params: GenerationLatestParams) => ["generation-latest", params.source, params.zones ?? []] as const,
  options: (params: GenerationLatestParams) =>
    queryOptions({
      queryKey: generationLatestCache.key(params),
      queryFn: async (): Promise<GenerationLatestResponse> => {
        const search = new URLSearchParams({ source: params.source });
        if (params.zones?.length) search.set("zone", params.zones.join(","));
        return generationLatestResponseSchema.parse(await apiFetch(`/generation-latest?${search}`, 300));
      },
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
