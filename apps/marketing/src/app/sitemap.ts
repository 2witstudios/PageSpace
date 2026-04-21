import type { MetadataRoute } from "next";
import { blogPosts } from "./blog/[slug]/data";

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

  // Documentation pages
  const docPaths = [
    "/docs",
    "/docs/getting-started",
    "/docs/core-concepts",
    "/docs/page-types",
    // AI
    "/docs/ai",
    "/docs/ai/providers",
    "/docs/ai/tool-calling",
    "/docs/ai/agents",
    // MCP
    "/docs/mcp",
    "/docs/mcp/desktop",
    // API Reference
    "/docs/api",
    "/docs/api/auth",
    "/docs/api/pages",
    "/docs/api/drives",
    "/docs/api/ai",
    "/docs/api/channels",
    "/docs/api/mcp",
    "/docs/api/files",
    "/docs/api/search",
    "/docs/api/users",
    "/docs/api/admin",
    // Security
    "/docs/security",
    "/docs/security/authentication",
    "/docs/security/permissions",
    "/docs/security/zero-trust",
  ];

  const docsRoutes: MetadataRoute.Sitemap = docPaths.map((path) => ({
    url: `${BASE_URL}${path}`,
    lastModified,
    changeFrequency: "weekly" as const,
    priority: path === "/docs" ? 0.8 : 0.6,
  }));

  // Blog routes - derived from blog data
  const blogRoutes: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/blog`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...Object.keys(blogPosts).map((slug) => ({
      url: `${BASE_URL}/blog/${slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];

  return [...staticRoutes, ...docsRoutes, ...blogRoutes];
}
