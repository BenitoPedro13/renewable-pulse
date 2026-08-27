import { plantsResponseSchema, type PlantRegistrySource, type PlantsResponse } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

/** apps/api caches each source's real response for an hour; a client refetch faster than that would never see new data. */
const REFETCH_INTERVAL_MS = 60 * 60 * 1000;

export const plantsCache = {
  key: (source: PlantRegistrySource) => ["plants", source] as const,
  options: (source: PlantRegistrySource) =>
    queryOptions({
      queryKey: plantsCache.key(source),
      queryFn: async (): Promise<PlantsResponse> => plantsResponseSchema.parse(await apiFetch(`/plants?source=${source}`, REFETCH_INTERVAL_MS / 1000)),
      refetchInterval: REFETCH_INTERVAL_MS,
      staleTime: REFETCH_INTERVAL_MS,
    }),
};
