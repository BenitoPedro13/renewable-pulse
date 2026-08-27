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

// The real, currently-deployed production URL (docs/tasks/TASK-railway-deploy.md)
// — required for Next to resolve absolute URLs for the OG image / icons.
// Update if a custom domain replaces it.
const siteUrl = "https://renewable-pulse.up.railway.app";
const description =
  "A live instrument panel for how much of the world's electricity already comes from renewables — Brazil's hydro-heavy grid, compared against Norway and the USA. Every reading traces back to a real ONS, ENTSO-E, or EIA API response.";

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
