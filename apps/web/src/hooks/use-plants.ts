import { useQuery } from "@tanstack/react-query";
import { plantsCache } from "@/lib/queries/plants";

/** ANEEL SIGA plant registry (coordinates + attributes, not live generation) — GET /plants. */
export function usePlants() {
  return useQuery(plantsCache.options());
}
