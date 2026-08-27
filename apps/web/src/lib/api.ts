/**
 * Base URL for apps/api's REST endpoints, read from the browser-safe env var
 * documented in .env.example. No trailing slash.
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Fetches `path` against API_BASE_URL and returns the parsed JSON body,
 * throwing ApiError on a non-2xx response.
 *
 * `revalidateSeconds`, when set, opts this call into Next's fetch Data
 * Cache (`next: { revalidate }`) — meaningful only when this runs during a
 * Server Component render (apps/web/src/app/page.tsx's prefetch); a plain
 * browser `fetch()` silently ignores the `next` option, so the same
 * queryFn works unmodified on the client. Only pass this for routes
 * apps/api itself marks cacheable (apps/api/src/cache-control.ts's
 * CACHEABLE_PATHS) — pipeline-health/dlq/ingestion-throughput must stay
 * live and never pass it.
 */
export async function apiFetch(path: string, revalidateSeconds?: number): Promise<unknown> {
  const init = revalidateSeconds !== undefined ? { next: { revalidate: revalidateSeconds } } : undefined;
  const res = await fetch(`${API_BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || `${res.status} ${res.statusText}`);
  }
  return res.json();
}
