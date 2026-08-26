import { generationMixResponseSchema, type GenerationMixResponse, type Source, type Zone } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

export interface GenerationMixParams {
  source: Source;
  zones: Zone[];
  from: string;
  to: string;
  bucket: "hour" | "day";
}

const REFETCH_INTERVAL_MS = 60_000;

export const generationMixCache = {
  key: (params: GenerationMixParams) => ["generation-mix", params] as const,
  options: (params: GenerationMixParams) =>
    queryOptions({
      queryKey: generationMixCache.key(params),
      queryFn: async (): Promise<GenerationMixResponse> => {
        const search = new URLSearchParams({
          source: params.source,
          zone: params.zones.join(","),
          from: params.from,
          to: params.to,
          bucket: params.bucket,
        });
        return generationMixResponseSchema.parse(await apiFetch(`/generation-mix?${search}`));
      },
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
