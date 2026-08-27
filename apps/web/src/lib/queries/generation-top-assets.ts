import { generationTopAssetsResponseSchema, type GenerationTopAssetsResponse, type Metric } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

export interface GenerationTopAssetsParams {
  metric: Metric;
  from: string;
  to: string;
  limit?: number;
}

const REFETCH_INTERVAL_MS = 5 * 60_000;

export const generationTopAssetsCache = {
  key: (params: GenerationTopAssetsParams) => ["generation-top-assets", params] as const,
  options: (params: GenerationTopAssetsParams) =>
    queryOptions({
      queryKey: generationTopAssetsCache.key(params),
      queryFn: async (): Promise<GenerationTopAssetsResponse> => {
        const search = new URLSearchParams({
          source: "ONS",
          metric: params.metric,
          from: params.from,
          to: params.to,
          limit: String(params.limit ?? 10),
        });
        return generationTopAssetsResponseSchema.parse(await apiFetch(`/generation-top-assets?${search}`, 300));
      },
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
