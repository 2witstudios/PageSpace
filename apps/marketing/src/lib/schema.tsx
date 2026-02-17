/**
 * Schema.org structured data for PageSpace marketing site
 * @see https://schema.org/
 * @see https://developers.google.com/search/docs/appearance/structured-data
 */

const SITE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://pagespace.ai";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";
const SOFTWARE_VERSION = "1.0";

/**
 * Organization schema - used site-wide
 */
export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "PageSpace",
  url: SITE_URL,
  logo: `${SITE_URL}/android-chrome-512x512.png`,
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
  description:
    "AI-powered unified workspace for documents, tasks, calendar, and team collaboration.",
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
 * Product schema with pricing offers
 */
export const productSchema = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "PageSpace",
  description:
    "AI-powered unified workspace for documents, tasks, calendar, and team collaboration.",
  brand: {
    "@type": "Brand",
    name: "PageSpace",
  },
  image: `${SITE_URL}/og-image.png`,
  offers: [
    {
      "@type": "Offer",
      name: "Free",
      price: "0",
      priceCurrency: "USD",
      description: "500MB storage, 50 daily AI calls, BYOK unlimited",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Pro",
      price: "15",
      priceCurrency: "USD",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "15",
        priceCurrency: "USD",
        billingDuration: "P1M",
      },
      description: "2GB storage, 200 daily AI calls, 50 Pro AI sessions",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Founder",
      price: "50",
      priceCurrency: "USD",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "50",
        priceCurrency: "USD",
        billingDuration: "P1M",
      },
      description: "10GB storage, 500 daily AI calls, 100 Pro AI sessions",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Business",
      price: "100",
      priceCurrency: "USD",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "100",
        priceCurrency: "USD",
        billingDuration: "P1M",
      },
      description: "50GB storage, 1000 daily AI calls, 500 Pro AI sessions",
      availability: "https://schema.org/InStock",
    },
  ],
};

/**
 * SoftwareApplication schema for downloads page
 */
export const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "PageSpace",
  applicationCategory: "ProductivityApplication",
  operatingSystem: "macOS, Windows, Linux, iOS, Android",
  softwareVersion: SOFTWARE_VERSION,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: organizationRef,
};

/**
 * FAQ schema - for FAQ page
 */
export interface FAQItem {
  question: string;
  answer: string;
}

export function createFAQSchema(faqs: FAQItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

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
 * BreadcrumbList schema - for navigation
 */
export interface BreadcrumbItem {
  name: string;
  path: string;
}

export function createBreadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
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
 * Helper to render JSON-LD script tag
 */
export function JsonLd({ data }: { data: object | object[] }) {
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
