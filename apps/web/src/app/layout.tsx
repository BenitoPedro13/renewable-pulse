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

export const metadata: Metadata = {
  title: "Renewable Pulse",
  description: "A live instrument panel for how much of the world's electricity already comes from renewables.",
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
