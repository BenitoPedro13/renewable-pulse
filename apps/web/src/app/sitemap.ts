import type { MetadataRoute } from "next";

const siteUrl = "https://renewable-pulse.vercel.app";

// Single-page dashboard today — add an entry here if apps/web ever grows
// additional routes.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      lastModified: new Date(),
      changeFrequency: "hourly",
      priority: 1,
    },
  ];
}
