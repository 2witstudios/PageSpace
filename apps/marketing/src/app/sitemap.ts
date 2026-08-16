import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://pagespace.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  // Core marketing pages - static routes
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/pricing`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/downloads`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/security`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/faq`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/homeschool`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/contact`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  // Docs and blog are NOT listed here. They are published PageSpace drives on
  // their own hosts now, and each emits its own sitemap.xml
  // (packages/lib/src/canvas/site-files.ts) with canonical URLs on that host.
  // Re-listing them under pagespace.ai would advertise URLs that only 301.
  return staticRoutes;
}
