import type { PlantRegistrySource } from "@renewable-pulse/contracts";
import { useQuery } from "@tanstack/react-query";
import { plantsCache } from "@/lib/queries/plants";

/** Real plant registry (coordinates + attributes, not live generation) — GET /plants. ANEEL SIGA for Brazil, EIA Form 860/860M for the USA. */
export function usePlants(source: PlantRegistrySource = "ANEEL_SIGA") {
  return useQuery(plantsCache.options(source));
}
