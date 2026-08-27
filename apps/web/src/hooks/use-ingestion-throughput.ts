import { useQuery } from "@tanstack/react-query";
import { ingestionThroughputCache, type IngestionThroughputParams } from "@/lib/queries/ingestion-throughput";

/** Real hourly persisted-reading counts per source (GET /ingestion-throughput). */
export function useIngestionThroughput(params: IngestionThroughputParams) {
  return useQuery(ingestionThroughputCache.options(params));
}
