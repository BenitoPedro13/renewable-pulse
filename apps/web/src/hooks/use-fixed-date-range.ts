"use client";

import { useState } from "react";
import { cachedDateRange, type CachedDateRange } from "@/lib/cached-date-range";

export type FixedDateRange = CachedDateRange;

/**
 * A [now - days, now] ISO range computed once per mount (not every render,
 * so it stays a stable TanStack Query key/cache identity) — shared by every
 * chart that windows its query to "the last N days". Rounded to a 5-minute
 * boundary (cachedDateRange) rather than a raw `new Date()`, so this
 * produces the exact same {from,to} apps/web/src/app/page.tsx's server-side
 * prefetch used for the same `days` value — required for the prefetched/
 * hydrated data to actually be found instead of silently refetched.
 */
export function useFixedDateRange(days: number): FixedDateRange {
  const [range] = useState<FixedDateRange>(() => cachedDateRange(days));
  return range;
}
