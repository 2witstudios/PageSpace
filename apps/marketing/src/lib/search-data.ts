import { blogPosts } from "@/app/blog/[slug]/data";

export interface SearchEntry {
  title: string;
  description: string;
  href: string;
  category: "Docs" | "Blog" | "FAQ" | "Pages";
  /** Extra text for cmdk to match against (hidden from display) */
  keywords?: string;
}

/** Strip markdown syntax for plain-text search matching */
function stripMarkdown(md: string): string {
  return md
    .replace(/#{1,6}\s/g, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

function buildBlogEntries(): SearchEntry[] {
  return Object.values(blogPosts).map((post) => ({
    title: post.title,
    description: post.description,
    href: `/blog/${post.slug}`,
    category: "Blog",
    keywords: stripMarkdown(post.content).slice(0, 500),
  }));
}

const docsEntries: SearchEntry[] = [
  {
    title: "Getting Started",
    description:
      "Learn how to set up PageSpace and create your first AI-powered workspace in minutes.",
    href: "/docs/getting-started",
    category: "Docs",
    keywords:
      "sign up account workspace document page agent channels tasks quick start setup",
  },
  {
    title: "Page Types",
    description:
      "PageSpace has 9 page types — Folder, Document, Channel, AI Chat, Canvas, File, Sheet, Task List, and Code.",
    href: "/docs/page-types",
    category: "Docs",
    keywords:
      "folder document channel ai chat canvas file sheet task list code tiptap monaco spreadsheet",
  },
  {
    title: "Features",
    description:
      "Behaviours every page shares — pages, drives, AI, sharing, search, accounts.",
    href: "/docs/features",
    category: "Docs",
    keywords:
      "features pages drives workspaces ai sharing permissions search accounts sign in",
  },
  {
    title: "Integrations",
    description:
      "Google Calendar, GitHub, and MCP — the three ways PageSpace connects outward and inward.",
    href: "/docs/integrations",
    category: "Docs",
    keywords:
      "integrations google calendar github mcp desktop external tools connect",
  },
  {
    title: "Google Calendar Integration",
    description:
      "Two-way sync of Google calendars into PageSpace; agents read availability and schedule.",
    href: "/docs/integrations/google-calendar",
    category: "Docs",
    keywords:
      "google calendar events schedule availability meetings sync",
  },
  {
    title: "GitHub Integration",
    description:
      "Give agents a GitHub identity to browse repos, file issues, and leave PR reviews.",
    href: "/docs/integrations/github",
    category: "Docs",
    keywords:
      "github repositories issues pull requests code review oauth",
  },
  {
    title: "MCP Integration",
    description:
      "Connect AI tools to your PageSpace workspace using Model Context Protocol, or add external MCP servers to PageSpace Desktop.",
    href: "/docs/integrations/mcp",
    category: "Docs",
    keywords:
      "mcp model context protocol token claude cursor desktop npx pagespace-mcp server filesystem github postgresql tools",
  },
];

const faqEntries: SearchEntry[] = [
  {
    title: "What is PageSpace?",
    description:
      "AI-powered workspace where you, your team, and AI work together.",
    href: "/faq",
    category: "FAQ",
  },
  {
    title: "Can I try PageSpace for free?",
    description:
      "Free plan includes 500 MB storage, 50 AI interactions per day, and all core features.",
    href: "/faq",
    category: "FAQ",
  },
  {
    title: "What are Page Agents?",
    description:
      "Specialized AI helpers that live in your workspace with custom system prompts and workspace context.",
    href: "/faq",
    category: "FAQ",
    keywords: "agent ai custom prompt role marketing expert project manager",
  },
  {
    title: "What is the Global Assistant?",
    description:
      "Personal AI that follows you across all workspaces and remembers preferences.",
    href: "/faq",
    category: "FAQ",
  },
  {
    title: "Is my data safe?",
    description: "Data encrypted in transit and at rest with industry-standard security.",
    href: "/faq",
    category: "FAQ",
    keywords: "security encryption privacy",
  },
  {
    title: "Is my content used to train AI?",
    description:
      "No. Workspace content is never used to train AI models.",
    href: "/faq",
    category: "FAQ",
    keywords: "training data privacy",
  },
  {
    title: "Can multiple people edit at the same time?",
    description: "Real-time collaboration with live cursors and changes.",
    href: "/faq",
    category: "FAQ",
    keywords: "collaboration real-time simultaneous editing",
  },
  {
    title: "Is there a desktop app?",
    description: "Desktop apps for macOS, Windows, and Linux with offline support.",
    href: "/faq",
    category: "FAQ",
    keywords: "download mac windows linux electron offline",
  },
  {
    title: "Can I use PageSpace on my phone?",
    description: "iOS app via TestFlight, Android coming soon, web works on mobile.",
    href: "/faq",
    category: "FAQ",
    keywords: "mobile ios android phone testflight",
  },
  {
    title: "What plans are available?",
    description: "Free, Pro, Founder, and Business plans available.",
    href: "/faq",
    category: "FAQ",
    keywords: "pricing plans free pro founder business",
  },
];

const pageEntries: SearchEntry[] = [
  {
    title: "Pricing",
    description: "Compare Free, Pro, Founder, and Business plans.",
    href: "/pricing",
    category: "Pages",
    keywords: "plans cost billing subscription",
  },
  {
    title: "Downloads",
    description: "Desktop apps for macOS, Windows, Linux, and iOS TestFlight.",
    href: "/downloads",
    category: "Pages",
    keywords: "install mac windows linux ios app desktop",
  },
  {
    title: "Blog",
    description: "Articles about PageSpace, AI, and productivity.",
    href: "/blog",
    category: "Pages",
  },
  {
    title: "Contact",
    description: "Get in touch with the PageSpace team.",
    href: "/contact",
    category: "Pages",
    keywords: "support help email",
  },
  {
    title: "Security",
    description: "How PageSpace protects your data.",
    href: "/security",
    category: "Pages",
    keywords: "encryption privacy trust safety",
  },
];

export const searchEntries: SearchEntry[] = [
  ...docsEntries,
  ...buildBlogEntries(),
  ...faqEntries,
  ...pageEntries,
];
