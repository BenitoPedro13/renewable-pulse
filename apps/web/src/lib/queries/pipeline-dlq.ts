import { dlqPreviewResponseSchema, type DlqPreviewResponse } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

/** Same cadence as pipeline-health — this changes on the order of the ingest poll interval. */
const REFETCH_INTERVAL_MS = 15_000;

export const pipelineDlqCache = {
  key: (limit: number) => ["pipeline-dlq", limit] as const,
  options: (limit: number) =>
    queryOptions({
      queryKey: pipelineDlqCache.key(limit),
      queryFn: async (): Promise<DlqPreviewResponse> => dlqPreviewResponseSchema.parse(await apiFetch(`/pipeline-health/dlq?limit=${limit}`)),
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
