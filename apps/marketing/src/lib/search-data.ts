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
      "Workspace for writing, tasks, and team communication with AI built in as a collaborator, not a chatbot sidebar.",
    href: "/faq#what-is-pagespace",
    category: "FAQ",
    keywords: "overview introduction what is pagespace",
  },
  {
    title: "How is PageSpace different from Notion or Google Docs?",
    description:
      "AI agents are actual workspace participants — they create pages, file issues, schedule meetings, and ask each other for help.",
    href: "/faq#how-is-it-different",
    category: "FAQ",
    keywords: "difference compare notion google docs obsidian alternative",
  },
  {
    title: "Is there a free plan?",
    description:
      "Yes. Free plan includes 500 MB storage and 50 AI calls per day. No credit card required.",
    href: "/faq#is-there-a-free-plan",
    category: "FAQ",
    keywords: "free plan pricing cost no credit card",
  },
  {
    title: "What happens when I run out of AI calls?",
    description:
      "Documents, tasks, channels, and collaboration keep working. AI pauses until your limit resets the next day.",
    href: "/faq#hit-daily-ai-limit",
    category: "FAQ",
    keywords: "daily limit ai calls reset quota",
  },
  {
    title: "How do I sign up?",
    description:
      "Passkey (Touch ID, Face ID, Windows Hello), magic link, or Google/Apple sign-in. No passwords.",
    href: "/faq#how-do-i-sign-up",
    category: "FAQ",
    keywords: "sign up account register passkey magic link google apple",
  },
  {
    title: "How do I get my team in?",
    description:
      "Invite by email from drive settings. Admins get full drive access; members only see pages you share.",
    href: "/faq#how-do-i-get-my-team-in",
    category: "FAQ",
    keywords: "invite team members email drive admin",
  },
  {
    title: "What can the AI actually do?",
    description:
      "Draft docs, build task lists, summarize threads, update spreadsheets, schedule meetings, file GitHub issues, and more.",
    href: "/faq#what-can-ai-do",
    category: "FAQ",
    keywords: "ai capabilities agent tools actions workspace",
  },
  {
    title: "Can I create a specialized AI assistant?",
    description:
      "Yes — place an AI agent anywhere and give it a role. It picks up context from where it sits in your workspace.",
    href: "/faq#specialized-ai-assistant",
    category: "FAQ",
    keywords: "agent ai chat role system prompt project assistant",
  },
  {
    title: "Is my content used to train AI models?",
    description:
      "No. Your content is never used for training by PageSpace or by the model providers.",
    href: "/faq#content-training",
    category: "FAQ",
    keywords: "training data privacy ai content",
  },
  {
    title: "If I share a folder, do people get access to everything inside it?",
    description:
      "No — pages inside each need their own share. Admins and owners are the exception.",
    href: "/faq#no-permission-inheritance",
    category: "FAQ",
    keywords: "permissions inheritance folder sharing drive roles owner admin member",
  },
  {
    title: "Is my data private?",
    description:
      "Yes. Encrypted at rest and in transit. API keys get an additional AES-256-GCM layer.",
    href: "/faq#is-my-data-private",
    category: "FAQ",
    keywords: "encryption security tls aes at rest in transit privacy",
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
    title: "Is there a desktop app?",
    description:
      "Yes — macOS, Windows, Linux. iOS via TestFlight. Android in progress.",
    href: "/faq#desktop-app",
    category: "FAQ",
    keywords: "download mac windows linux ios android electron desktop",
  },
  {
    title: "Can I connect PageSpace to Claude, Cursor, or other AI tools?",
    description:
      "Yes — via the PageSpace MCP server. Create a token, point your client at the endpoint.",
    href: "/faq#connect-to-claude-cursor",
    category: "FAQ",
    keywords: "mcp claude cursor anthropic client external ai model context protocol",
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
