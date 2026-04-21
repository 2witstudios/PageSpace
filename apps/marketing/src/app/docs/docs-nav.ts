import {
  Book,
  Sparkles,
  Cpu,
  Bot,
  Wrench,
  Server,
  Monitor,
  Shield,
  KeyRound,
  Users,
  Eye,
  HardDrive,
  LayoutGrid,
  FileText,
  Blocks,
  MessageSquare,
  Search,
  Lightbulb,
  ListChecks,
  Upload,
  Folder,
  Palette,
  Table,
  Code,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon?: typeof Book;
}

export interface NavSection {
  title: string;
  icon: typeof Book;
  items: NavItem[];
}

export const docsNav: NavSection[] = [
  {
    title: "Getting Started",
    icon: Book,
    items: [
      { title: "Overview", href: "/docs" },
      { title: "Quick Start", href: "/docs/getting-started", icon: Book },
      { title: "Core Concepts", href: "/docs/core-concepts", icon: Blocks },
      { title: "Page Types", href: "/docs/page-types", icon: LayoutGrid },
    ],
  },
  {
    title: "How it Works",
    icon: Lightbulb,
    items: [
      { title: "Overview", href: "/docs/how-it-works", icon: Lightbulb },
      { title: "Pages", href: "/docs/how-it-works/pages", icon: FileText },
      { title: "Documents", href: "/docs/how-it-works/documents", icon: FileText },
      { title: "Folders", href: "/docs/how-it-works/folders", icon: Folder },
      { title: "AI in your Workspace", href: "/docs/how-it-works/ai", icon: Sparkles },
      { title: "Channels", href: "/docs/how-it-works/channels", icon: MessageSquare },
      { title: "Task Lists", href: "/docs/how-it-works/task-lists", icon: ListChecks },
      { title: "Sheets", href: "/docs/how-it-works/sheets", icon: Table },
      { title: "Canvas", href: "/docs/how-it-works/canvas", icon: Palette },
      { title: "Code", href: "/docs/how-it-works/code", icon: Code },
      { title: "Files & Uploads", href: "/docs/how-it-works/files", icon: Upload },
      { title: "Drives & Workspaces", href: "/docs/how-it-works/drives", icon: HardDrive },
      { title: "Search", href: "/docs/how-it-works/search", icon: Search },
      { title: "Sharing & Permissions", href: "/docs/how-it-works/sharing", icon: Users },
      { title: "Accounts & Sign In", href: "/docs/how-it-works/accounts", icon: KeyRound },
    ],
  },
  {
    title: "AI System",
    icon: Sparkles,
    items: [
      { title: "AI Overview", href: "/docs/ai", icon: Sparkles },
      { title: "Providers & Models", href: "/docs/ai/providers", icon: Cpu },
      { title: "Tool Calling", href: "/docs/ai/tool-calling", icon: Wrench },
      { title: "Agents", href: "/docs/ai/agents", icon: Bot },
    ],
  },
  {
    title: "MCP Integration",
    icon: Server,
    items: [
      { title: "MCP Overview", href: "/docs/mcp", icon: Server },
      { title: "Desktop MCP", href: "/docs/mcp/desktop", icon: Monitor },
    ],
  },
  {
    title: "Security & Auth",
    icon: Shield,
    items: [
      { title: "Security Overview", href: "/docs/security", icon: Shield },
      { title: "Authentication", href: "/docs/security/authentication", icon: KeyRound },
      { title: "Permissions", href: "/docs/security/permissions", icon: Users },
      { title: "Zero-Trust", href: "/docs/security/zero-trust", icon: Eye },
    ],
  },
];

/** Flat list of all nav items for prev/next navigation */
export const flatNavItems: NavItem[] = docsNav.flatMap((section) => section.items);

export function getNavContext(href: string) {
  const idx = flatNavItems.findIndex((item) => item.href === href);
  if (idx === -1) return { current: null, prev: null, next: null };
  return {
    current: flatNavItems[idx] ?? null,
    prev: idx > 0 ? flatNavItems[idx - 1] : null,
    next: idx < flatNavItems.length - 1 ? flatNavItems[idx + 1] : null,
  };
}

export function getBreadcrumbs(href: string): { title: string; href: string }[] {
  for (const section of docsNav) {
    const item = section.items.find((i) => i.href === href);
    if (item) {
      const crumbs = [{ title: "Docs", href: "/docs" }];
      if (item.href !== "/docs") {
        const sectionHref = section.items[0].href;
        if (sectionHref !== "/docs") {
          crumbs.push({ title: section.title, href: sectionHref });
        }
        if (item.href !== section.items[0].href) {
          crumbs.push({ title: item.title, href: item.href });
        }
      }
      return crumbs;
    }
  }
  return [{ title: "Docs", href: "/docs" }];
}
