import { generationShareResponseSchema, type GenerationShareResponse, type Source } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

export interface GenerationShareParams {
  sources: Source[];
  from: string;
  to: string;
}

const REFETCH_INTERVAL_MS = 60_000;

export const generationShareCache = {
  key: (params: GenerationShareParams) => ["generation-share", params] as const,
  options: (params: GenerationShareParams) =>
    queryOptions({
      queryKey: generationShareCache.key(params),
      queryFn: async (): Promise<GenerationShareResponse> => {
        const search = new URLSearchParams({
          source: params.sources.join(","),
          from: params.from,
          to: params.to,
          bucket: "day",
        });
        return generationShareResponseSchema.parse(await apiFetch(`/generation-share?${search}`, 300));
      },
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
