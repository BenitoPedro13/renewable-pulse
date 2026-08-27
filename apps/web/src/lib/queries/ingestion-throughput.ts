import { ingestionThroughputResponseSchema, type IngestionThroughputResponse } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

export interface IngestionThroughputParams {
  from: string;
  to: string;
}

const REFETCH_INTERVAL_MS = 60_000;

export const ingestionThroughputCache = {
  key: (params: IngestionThroughputParams) => ["ingestion-throughput", params] as const,
  options: (params: IngestionThroughputParams) =>
    queryOptions({
      queryKey: ingestionThroughputCache.key(params),
      queryFn: async (): Promise<IngestionThroughputResponse> => {
        const search = new URLSearchParams({ from: params.from, to: params.to });
        return ingestionThroughputResponseSchema.parse(await apiFetch(`/ingestion-throughput?${search}`));
      },
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
