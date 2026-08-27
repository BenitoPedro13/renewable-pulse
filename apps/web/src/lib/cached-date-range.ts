// A raw `new Date()` makes every request's {from,to} pair — and therefore
// every request URL — unique down to the millisecond, which means nothing
// can ever share a cache entry: not TanStack Query's client cache across
// re-renders, not Next's fetch Data Cache, not Vercel's edge cache. Rounding
// `to` down to a coarse boundary makes many requests within the same window
// produce a byte-identical URL, which is what actually lets a server-side
// prefetch (apps/web/src/app/page.tsx) and a later client hook read (or a
// different visitor's request) hit the same cached response.
//
// 5 minutes matches apps/api's own Cache-Control window
// (apps/api/src/cache-control.ts's max-age=300) — the two cache layers stay
// in sync on purpose. No route here needs finer freshness than that: every
// upstream source refreshes on the order of an hour (docs/architecture.md
// §2).
const CACHE_WINDOW_MS = 5 * 60 * 1000;

export interface CachedDateRange {
  from: string;
  to: string;
}

/** Deterministic within any given 5-minute window — safe to call independently on the server (prefetch) and the client (hooks) and get the same {from,to}. */
export function cachedDateRange(days: number): CachedDateRange {
  const now = Date.now();
  const to = new Date(now - (now % CACHE_WINDOW_MS));
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}
