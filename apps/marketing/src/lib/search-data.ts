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
      "AI-native workspace where pages and AI agents share the same tree.",
    href: "/faq#what-is-pagespace",
    category: "FAQ",
  },
  {
    title: "What makes PageSpace different?",
    description:
      "Pages and AI share one tree, permissions don't cascade, and security primitives are inspectable.",
    href: "/faq#what-makes-pagespace-different",
    category: "FAQ",
    keywords: "difference compare notion docs obsidian alternative",
  },
  {
    title: "Is PageSpace open source?",
    description:
      "PageSpace is proprietary. Self-hosting is available as a deployment option.",
    href: "/faq#is-pagespace-open-source",
    category: "FAQ",
    keywords: "open source license proprietary oss",
  },
  {
    title: "If I share a folder, do people get access to everything inside it?",
    description:
      "No — pages inside a folder each need their own grant. Drive Owner and Admin roles cover everything automatically.",
    href: "/faq#no-permission-inheritance",
    category: "FAQ",
    keywords: "permissions inheritance folder sharing drive roles owner admin member",
  },
  {
    title: "What are AI agents?",
    description:
      "AI Chat pages placed in your tree with a role, model, and tool allow-list — context from their position.",
    href: "/faq#what-are-ai-agents",
    category: "FAQ",
    keywords: "agent ai chat role system prompt tools model",
  },
  {
    title: "What is the Global Assistant?",
    description:
      "Personal AI that follows you across every drive you're a member of.",
    href: "/faq#what-is-global-assistant",
    category: "FAQ",
  },
  {
    title: "What does Bring Your Own Key mean?",
    description:
      "Plug in your own provider API keys to bypass daily AI limits. Encrypted at rest with AES-256-GCM.",
    href: "/faq#what-is-byok",
    category: "FAQ",
    keywords: "byok bring your own key api anthropic openai google openrouter",
  },
  {
    title: "Is my content used to train AI models?",
    description:
      "No. Workspace content is never used to train AI models, ours or anyone else's.",
    href: "/faq#content-training",
    category: "FAQ",
    keywords: "training data privacy ai",
  },
  {
    title: "How is my data encrypted?",
    description:
      "TLS in transit, volume encryption at rest, AES-256-GCM for secrets.",
    href: "/faq#how-is-data-encrypted",
    category: "FAQ",
    keywords: "encryption security tls aes at rest in transit",
  },
  {
    title: "What's the audit log?",
    description:
      "SHA-256 hash-chain over security events, re-verified on a schedule and before external delivery.",
    href: "/faq#audit-log",
    category: "FAQ",
    keywords: "audit log siem hash chain security events compliance",
  },
  {
    title: "Can I export my data?",
    description:
      "Markdown/.docx for docs, CSV/XLSX for sheets, source files for code, originals for uploads.",
    href: "/faq#can-i-export-data",
    category: "FAQ",
    keywords: "export data portability markdown docx csv",
  },
  {
    title: "Can I connect PageSpace to Claude or Cursor?",
    description:
      "Yes — via the PageSpace MCP server. Issue a scoped token and point your client at the endpoint.",
    href: "/faq#connect-to-claude-cursor",
    category: "FAQ",
    keywords: "mcp claude cursor anthropic client external ai",
  },
  {
    title: "Is there a desktop app?",
    description:
      "Yes — macOS, Windows, Linux. Deeper OS integration than the browser allows.",
    href: "/faq#desktop-app",
    category: "FAQ",
    keywords: "download mac windows linux electron desktop",
  },
  {
    title: "Can I use PageSpace on my phone?",
    description:
      "iOS via TestFlight, Android in progress, web works in any modern mobile browser.",
    href: "/faq#mobile-app",
    category: "FAQ",
    keywords: "mobile ios android phone testflight",
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
