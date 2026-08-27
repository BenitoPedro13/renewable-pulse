import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { LiveIndicator } from "@/components/dashboard/live-indicator";
import { prefetchDashboardQueries } from "@/lib/prefetch-dashboard";

/**
 * A Server Component on purpose (CLAUDE.md: "Server Components by
 * default") — it prefetches every query the dashboard's first paint needs
 * (prefetch-dashboard.ts) into a fresh, request-scoped QueryClient (never
 * the browser singleton QueryProvider.tsx owns — matching the same
 * per-server-render rule that file already documents), then dehydrates that
 * state into a HydrationBoundary so DashboardShell's existing client hooks
 * find the data already in cache instead of issuing their own fetch. This
 * is what lets Next's fetch Data Cache (apiFetch's revalidateSeconds) — and
 * on Vercel, its edge network — actually serve a different visitor's
 * request from cache, not just speed up a repeat visit in the same browser.
 */
export default async function Home() {
  const queryClient = new QueryClient();
  await prefetchDashboardQueries(queryClient);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-title-h4 text-text-strong-950">Renewable Pulse</h1>
          <LiveIndicator />
        </div>
        <p className="text-paragraph-sm text-text-sub-600">
          A live instrument panel for how much of the world&apos;s electricity already comes from renewables.
        </p>
      </header>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <DashboardShell />
      </HydrationBoundary>
    </main>
  );
}
