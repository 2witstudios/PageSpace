/**
 * Schema.org structured data for PageSpace marketing site
 * @see https://schema.org/
 * @see https://developers.google.com/search/docs/appearance/structured-data
 */
import { ENTITY_DESCRIPTION } from "./metadata";

// In development, set NEXT_PUBLIC_MARKETING_URL and NEXT_PUBLIC_APP_URL to distinct local origins
const SITE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://pagespace.ai";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";
const SOFTWARE_VERSION = "1.0";

/**
 * Organization schema - used site-wide.
 * `description` uses the canonical entity sentence so AI engines resolve THIS
 * product (not the colliding web-design agency of the same name). AEO: entity
 * disambiguation.
 */
export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "PageSpace",
  legalName: "PageSpace",
  url: SITE_URL,
  logo: `${SITE_URL}/android-chrome-512x512.png`,
  description: ENTITY_DESCRIPTION,
  sameAs: [
    "https://twitter.com/PageSpaceAI",
    "https://github.com/2witstudios/PageSpace",
  ],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: "support@pagespace.ai",
  },
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { "@context": _context, ...organizationRef } = organizationSchema;

/**
 * WebApplication schema - for the landing page
 */
export const webApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "PageSpace",
  url: APP_URL,
  applicationCategory: "ProductivityApplication",
  operatingSystem: "Web, macOS, Windows, Linux, iOS, Android",
  description: ENTITY_DESCRIPTION,
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: "0",
    highPrice: "100",
    offerCount: 4,
  },
  featureList: [
    "AI-powered document editing",
    "Real-time collaboration",
    "Task management with AI assignment",
    "Unified calendar view",
    "Team channels and messaging",
    "Hierarchical AI agents",
    "Custom AI system prompts",
    "MCP server integration",
  ],
  screenshot: `${SITE_URL}/og-image.png`,
  softwareVersion: SOFTWARE_VERSION,
  author: organizationRef,
};

/**
 * Article schema - for blog posts
 */
export interface ArticleData {
  title: string;
  description: string;
  slug: string;
  publishedAt: string;
  modifiedAt?: string;
  author?: string;
  image?: string;
}

export function createArticleSchema(article: ArticleData) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.description,
    url: `${SITE_URL}/blog/${article.slug}`,
    datePublished: article.publishedAt,
    dateModified: article.modifiedAt || article.publishedAt,
    author: {
      "@type": "Person",
      name: article.author || "PageSpace Team",
    },
    publisher: organizationRef,
    image: article.image || `${SITE_URL}/og-image.png`,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${SITE_URL}/blog/${article.slug}`,
    },
  };
}

/**
 * WebSite schema
 */
export const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "PageSpace",
  url: SITE_URL,
};

/**
 * FAQPage schema - built from the homepage FAQ (AEO: FAQ coverage + fan-out).
 * `name`/`text` must mirror the visible question/answer text.
 */
export function createFaqSchema(items: { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };
}

/**
 * Review schema - machine-readable social proof for a testimonial (AEO: trust).
 */
export function createReviewSchema(review: {
  author: string;
  body: string;
  url?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Review",
    itemReviewed: {
      "@type": "SoftwareApplication",
      name: "PageSpace",
      applicationCategory: "ProductivityApplication",
      operatingSystem: "Web, macOS, Windows, Linux, iOS, Android",
    },
    reviewRating: {
      "@type": "Rating",
      ratingValue: "5",
      bestRating: "5",
    },
    author: {
      "@type": "Person",
      name: review.author,
    },
    reviewBody: review.body,
    ...(review.url ? { url: review.url } : {}),
  };
}

/**
 * Helper to render JSON-LD script tag
 */
type JsonLdData = Record<string, unknown>;

export function JsonLd({ data }: { data: JsonLdData | JsonLdData[] }) {
  const jsonLd = Array.isArray(data) ? data : [data];

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
      }}
    />
  );
}
