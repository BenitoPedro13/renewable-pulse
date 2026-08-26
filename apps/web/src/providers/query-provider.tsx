"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Next.js's official TanStack Query App Router pattern (verified against
 * nextjs.org/docs/app/guides/client-side-data-fetching/tanstack-query,
 * CLAUDE.md "Frontend state conventions"): a brand-new QueryClient per
 * server render (keeps requests isolated), one reused QueryClient singleton
 * in the browser (keeps the cache across client re-renders) — never a plain
 * `useState(() => new QueryClient())`.
 */
let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return new QueryClient();
  browserQueryClient ??= new QueryClient();
  return browserQueryClient;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>;
}
