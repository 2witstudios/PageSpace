import type { Metadata } from "next";

const SITE_NAME = "PageSpace";
const SITE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://pagespace.ai";
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;
const TWITTER_HANDLE = "@PageSpaceAI";

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";

export interface PageMetadata {
  title: string;
  description: string;
  path?: string;
  image?: string;
  noIndex?: boolean;
  keywords?: string[];
}

/**
 * Generate comprehensive metadata for a marketing page
 */
export function createMetadata({
  title,
  description,
  path = "",
  image = DEFAULT_OG_IMAGE,
  noIndex = false,
  keywords = [],
}: PageMetadata): Metadata {
  const url = `${SITE_URL}${path}`;
  const ogTitle = path === "" ? title : `${title} | ${SITE_NAME}`;

  return {
    title: path === "" ? { absolute: title } : title,
    description,
    keywords: [
      "PageSpace",
      "AI workspace",
      "unified workspace",
      "AI collaboration",
      "productivity",
      "team collaboration",
      ...keywords,
    ],
    authors: [{ name: "PageSpace" }],
    creator: "PageSpace",
    publisher: "PageSpace",
    robots: noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    alternates: {
      canonical: url,
    },
    openGraph: {
      type: "website",
      locale: "en_US",
      url,
      siteName: SITE_NAME,
      title: ogTitle,
      description,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      site: TWITTER_HANDLE,
      creator: TWITTER_HANDLE,
      title: ogTitle,
      description,
      images: [image],
    },
  };
}

/**
 * Default site-wide metadata
 */
export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "PageSpace - AI-Powered Unified Workspace",
    template: "%s | PageSpace",
  },
  description:
    "Your AI-powered workspace for documents, tasks, calendar, and team collaboration. Work with AI that understands your entire workspace.",
  keywords: [
    "PageSpace",
    "AI workspace",
    "unified workspace",
    "AI collaboration",
    "productivity software",
    "team collaboration",
    "document editor",
    "task management",
    "AI assistant",
    "real-time collaboration",
  ],
  authors: [{ name: "PageSpace" }],
  creator: "PageSpace",
  publisher: "PageSpace",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
  },
  manifest: "/manifest.json",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: "PageSpace - AI-Powered Unified Workspace",
    description:
      "Your AI-powered workspace for documents, tasks, calendar, and team collaboration. Work with AI that understands your entire workspace.",
    images: [
      {
        url: DEFAULT_OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "PageSpace - AI-Powered Unified Workspace",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: TWITTER_HANDLE,
    creator: TWITTER_HANDLE,
    title: "PageSpace - AI-Powered Unified Workspace",
    description:
      "Your AI-powered workspace for documents, tasks, calendar, and team collaboration. Work with AI that understands your entire workspace.",
    images: [DEFAULT_OG_IMAGE],
  },
  category: "technology",
};

export const LEGAL_LAST_UPDATED = "February 17, 2026";

/**
 * Pre-defined metadata for common pages
 */
export const pageMetadata = {
  home: createMetadata({
    title: "PageSpace - AI-Powered Unified Workspace",
    description:
      "Your AI-powered workspace for documents, tasks, calendar, and team collaboration. Work with AI that understands your entire workspace.",
    path: "",
  }),

  pricing: createMetadata({
    title: "Pricing",
    description:
      "Simple, transparent pricing for individuals, teams, and enterprises. Start free with 500MB storage and 50 daily AI calls.",
    path: "/pricing",
    keywords: ["pricing", "plans", "free tier", "subscription"],
  }),

  downloads: createMetadata({
    title: "Download PageSpace for Mac, Windows, Linux, iOS, Android",
    description:
      "Download PageSpace for your desktop or mobile device. Available for macOS, Windows, Linux, iOS, and Android.",
    path: "/downloads",
    keywords: ["download", "desktop app", "mobile app", "macOS", "Windows", "Linux", "iOS", "Android"],
  }),

  blog: createMetadata({
    title: "Blog",
    description:
      "Latest news, updates, and insights from the PageSpace team. Learn about AI, productivity, and building better workspaces.",
    path: "/blog",
    keywords: ["blog", "news", "updates", "AI", "productivity"],
  }),

  docs: createMetadata({
    title: "Documentation",
    description:
      "PageSpace developer documentation. Learn how to use the API, integrate MCP servers, and extend your workspace.",
    path: "/docs",
    keywords: ["documentation", "API", "developers", "MCP", "integration"],
  }),

  gettingStarted: createMetadata({
    title: "Getting Started",
    description:
      "Learn how to set up PageSpace and create your first AI-powered workspace in minutes.",
    path: "/docs/getting-started",
    keywords: ["getting started", "setup", "quickstart", "tutorial"],
  }),

  faq: createMetadata({
    title: "FAQ",
    description:
      "Frequently asked questions about PageSpace. Get answers about features, pricing, privacy, and more.",
    path: "/faq",
    keywords: ["FAQ", "help", "support", "questions"],
  }),

  privacy: createMetadata({
    title: "Privacy Policy",
    description:
      "Learn how PageSpace collects, uses, and protects your information in our cloud-based workspace platform.",
    path: "/privacy",
    keywords: ["privacy policy", "data protection", "GDPR", "security"],
  }),

  terms: createMetadata({
    title: "Terms of Service",
    description:
      "Terms of Service for PageSpace, the AI-powered unified workspace platform.",
    path: "/terms",
    keywords: ["terms of service", "terms", "legal", "agreement"],
  }),

  contact: createMetadata({
    title: "Contact Us",
    description:
      "Get in touch with the PageSpace team. We'd love to hear from you about questions, feedback, or enterprise inquiries.",
    path: "/contact",
    keywords: ["contact", "support", "sales", "help"],
  }),

  mcp: createMetadata({
    title: "MCP Integration",
    description:
      "Connect AI tools like Claude and Cursor to PageSpace via MCP. Set up tokens, configure servers, and manage local MCP tools in the desktop app.",
    path: "/docs/mcp",
    keywords: ["MCP", "Model Context Protocol", "AI integration", "Claude", "Cursor", "API tokens"],
  }),

  pageTypes: createMetadata({
    title: "Page Types",
    description:
      "Explore the 9 page types in PageSpace: documents, channels, AI chats, canvases, sheets, task lists, code files, and more.",
    path: "/docs/page-types",
    keywords: ["page types", "documents", "channels", "AI chat", "canvas", "sheets", "tasks", "code editor"],
  }),
};
