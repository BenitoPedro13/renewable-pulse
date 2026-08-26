import { plantsResponseSchema, type PlantsResponse } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

/** apps/api caches the real ANEEL SIGA response for an hour; a client refetch faster than that would never see new data. */
const REFETCH_INTERVAL_MS = 60 * 60 * 1000;

export const plantsCache = {
  key: ["plants"] as const,
  options: () =>
    queryOptions({
      queryKey: plantsCache.key,
      queryFn: async (): Promise<PlantsResponse> => plantsResponseSchema.parse(await apiFetch("/plants")),
      refetchInterval: REFETCH_INTERVAL_MS,
      staleTime: REFETCH_INTERVAL_MS,
    }),
};
