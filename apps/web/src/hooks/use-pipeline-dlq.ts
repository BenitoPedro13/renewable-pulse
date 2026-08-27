import { useQuery } from "@tanstack/react-query";
import { pipelineDlqCache } from "@/lib/queries/pipeline-dlq";

/** A real-time, read-only preview of readings.dlq (GET /pipeline-health/dlq). */
export function usePipelineDlq(limit = 20) {
  return useQuery(pipelineDlqCache.options(limit));
}
