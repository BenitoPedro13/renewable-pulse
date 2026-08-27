import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { LiveProvider } from "@/providers/live-client-provider";
import { QueryProvider } from "@/providers/query-provider";
import "./globals.css";

// Inter (docs/brand.md §3), matching Flora's base font — exposes tabular
// figures via OpenType `tnum`, applied selectively via .tabular-nums on
// live-updating numbers rather than switching typefaces.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// The real, currently-deployed production URL (docs/tasks/TASK-railway-deploy.md
// §7 — apps/web moved off Railway to Vercel-only 2026-08-27) — required for
// Next to resolve absolute URLs for the OG image / icons. Update if a custom
// domain replaces it.
const siteUrl = "https://renewable-pulse.vercel.app";
// Kept under ~160 characters — Google truncates meta descriptions around
// there, and the same string doubles as the OG/X description.
const description =
  "A live instrument panel for how much of the world's electricity comes from renewables — Brazil, Norway, and the USA, tracked from real ONS/ENTSO-E/EIA data.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Renewable Pulse",
    template: "%s · Renewable Pulse",
  },
  description,
  keywords: [
    "renewable energy",
    "grid data",
    "electricity generation",
    "Brazil ONS",
    "EIA",
    "ENTSO-E",
    "live dashboard",
    "energy mix",
  ],
  authors: [{ name: "Renewable Pulse" }],
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Renewable Pulse",
    title: "Renewable Pulse",
    description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Renewable Pulse",
    description,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-bg-white-0 text-text-strong-950 font-sans">
        <QueryProvider>
          <LiveProvider>{children}</LiveProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
