import { useState } from "react";

export interface FixedDateRange {
  from: string;
  to: string;
}

/** A [now - days, now] ISO range computed once per mount (not every render, so it stays a stable TanStack Query key/cache identity) — shared by every chart that windows its query to "the last N days". */
export function useFixedDateRange(days: number): FixedDateRange {
  const [range] = useState<FixedDateRange>(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  });
  return range;
}
