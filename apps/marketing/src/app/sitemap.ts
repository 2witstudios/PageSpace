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
      url: `${BASE_URL}/tour`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/integrations`,
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
      url: `${BASE_URL}/changelog`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.6,
    },
  ];

  // Developer documentation pages
  const docsRoutes: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/docs`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/docs/getting-started`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/docs/api`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/docs/mcp`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];

  // Blog routes
  const blogRoutes: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/blog`,
      lastModified,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/blog/introducing-pagespace`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/blog/understanding-page-agents`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/blog/mcp-servers-explained`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/blog/ai-rollback-why-it-matters`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];

  return [...staticRoutes, ...docsRoutes, ...blogRoutes];
}
