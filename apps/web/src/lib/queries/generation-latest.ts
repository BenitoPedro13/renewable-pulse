import { generationLatestResponseSchema, type GenerationLatestResponse, type Zone } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

export interface GenerationLatestParams {
  zones?: Zone[];
}

const REFETCH_INTERVAL_MS = 30_000;

export const generationLatestCache = {
  key: (params: GenerationLatestParams) => ["generation-latest", params.zones ?? []] as const,
  options: (params: GenerationLatestParams) =>
    queryOptions({
      queryKey: generationLatestCache.key(params),
      queryFn: async (): Promise<GenerationLatestResponse> => {
        const search = new URLSearchParams({ source: "ONS" });
        if (params.zones?.length) search.set("zone", params.zones.join(","));
        return generationLatestResponseSchema.parse(await apiFetch(`/generation-latest?${search}`));
      },
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
