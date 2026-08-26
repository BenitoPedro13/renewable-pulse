import { pipelineHealthResponseSchema, type PipelineHealthResponse } from "@renewable-pulse/contracts";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../api";

/** Refetch cadence for the pipeline-health panel — this data changes on the order of the ingest poll interval, not sub-second. */
const REFETCH_INTERVAL_MS = 15_000;

export const pipelineHealthCache = {
  key: ["pipeline-health"] as const,
  options: () =>
    queryOptions({
      queryKey: pipelineHealthCache.key,
      queryFn: async (): Promise<PipelineHealthResponse> => pipelineHealthResponseSchema.parse(await apiFetch("/pipeline-health")),
      refetchInterval: REFETCH_INTERVAL_MS,
    }),
};
