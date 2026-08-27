import type { Zone } from "@renewable-pulse/contracts";
import { zoneSchema } from "@renewable-pulse/contracts";

/** Brazil's five ONS subsystems. */
export const ONS_ZONES = zoneSchema.options.filter((zone): zone is Zone & `BR-${string}` => zone.startsWith("BR-"));

/**
 * The seven RTO/ISO respondents added for USA regional depth
 * (docs/tasks/TASK-live-dashboard.md §2.8) — deliberately excludes
 * "US-US48", which is the sum of these regions (and others EIA does not
 * break out), so it doesn't appear as one more "region" alongside the sums
 * it already contains.
 */
export const USA_REGIONAL_ZONES: Zone[] = ["US-CISO", "US-ERCO", "US-ISNE", "US-MISO", "US-NYIS", "US-PJM", "US-SWPP"];

/**
 * ENTSO-E's six configured bidding zones (Norway's five plus the
 * Netherlands' one — packages/contracts/src/event.ts). Unlike
 * USA_REGIONAL_ZONES, ENTSO-E has no single national-aggregate zone code
 * to exclude, so this list doubles as both "all of Europe" and the
 * per-zone regional breakdown.
 */
export const ENTSOE_ZONES: Zone[] = ["NO-NO1", "NO-NO2", "NO-NO3", "NO-NO4", "NO-NO5", "NL"];
