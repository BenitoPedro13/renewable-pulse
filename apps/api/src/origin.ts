/**
 * Shared CORS/WebSocket origin-allowlist logic (docs/tasks/TASK-live-dashboard.md
 * §2.6). Extracted out of index.ts so it can be exercised directly in
 * cors.spec.ts without booting the full app (DB pool, Kafka consumer).
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** A missing Origin header (curl, server-to-server) is always allowed; browser requests must match the allowlist. */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  return !origin || allowedOrigins.includes(origin);
}
