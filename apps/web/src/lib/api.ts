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

/** Fetches `path` against API_BASE_URL and returns the parsed JSON body, throwing ApiError on a non-2xx response. */
export async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || `${res.status} ${res.statusText}`);
  }
  return res.json();
}
