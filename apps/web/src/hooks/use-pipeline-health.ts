import { useQuery } from "@tanstack/react-query";
import { pipelineHealthCache } from "@/lib/queries/pipeline-health";

/** DLQ depth, persist-consumer lag, and last-successful-poll-per-source (GET /pipeline-health). */
export function usePipelineHealth() {
  return useQuery(pipelineHealthCache.options());
}
