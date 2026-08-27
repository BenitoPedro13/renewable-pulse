// The upstream sources refresh on the order of an hour (docs/architecture.md
// §2) and every reading is identical for every visitor — there's no
// per-user variation to invalidate on. A short browser/CDN cache trades an
// imperceptible staleness window for a large cut in repeat load on
// TimescaleDB, without affecting the /live WebSocket's actual real-time
// delivery.
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=1800";

// Deliberately an allowlist, not "everything except /live" — pipeline
// health must always reflect current state (it's the honesty mechanism
// docs/architecture.md §5 relies on: real DLQ depth / consumer lag / last
// poll, not a cached snapshot), so it's excluded on purpose, not by
// omission.
const CACHEABLE_PATHS = new Set([
  "/readings",
  "/generation-mix",
  "/generation-latest",
  "/generation-share",
  "/generation-top-assets",
  "/plants",
]);

export function cacheControlFor(method: string, pathname: string): string | null {
  if (method !== "GET") return null;
  return CACHEABLE_PATHS.has(pathname) ? CACHE_CONTROL : null;
}
