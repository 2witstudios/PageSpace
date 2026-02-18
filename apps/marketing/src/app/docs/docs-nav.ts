import {
  Book,
  Sparkles,
  Cpu,
  Bot,
  Wrench,
  Server,
  Monitor,
  Code2,
  Shield,
  KeyRound,
  Users,
  Eye,
  HardDrive,
  Container,
  Settings,
  Network,
  LayoutGrid,
  FileText,
  Blocks,
  MessageSquare,
  Search,
  UserCog,
  Bell,
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
    title: "API Reference",
    icon: Code2,
    items: [
      { title: "API Overview", href: "/docs/api", icon: Code2 },
      { title: "Authentication", href: "/docs/api/auth", icon: KeyRound },
      { title: "Pages", href: "/docs/api/pages", icon: FileText },
      { title: "Drives", href: "/docs/api/drives", icon: HardDrive },
      { title: "AI", href: "/docs/api/ai", icon: Sparkles },
      { title: "Channels", href: "/docs/api/channels", icon: MessageSquare },
      { title: "MCP", href: "/docs/api/mcp", icon: Server },
      { title: "Files", href: "/docs/api/files", icon: FileText },
      { title: "Search", href: "/docs/api/search", icon: Search },
      { title: "Users", href: "/docs/api/users", icon: UserCog },
      { title: "Admin", href: "/docs/api/admin", icon: Bell },
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
  {
    title: "Self-Hosting",
    icon: HardDrive,
    items: [
      { title: "Deployment Overview", href: "/docs/self-hosting", icon: HardDrive },
      { title: "Docker Setup", href: "/docs/self-hosting/docker", icon: Container },
      { title: "Environment", href: "/docs/self-hosting/environment", icon: Settings },
      { title: "Architecture", href: "/docs/self-hosting/architecture", icon: Network },
    ],
  },
];

/** Flat list of all nav items for prev/next navigation */
export const flatNavItems: NavItem[] = docsNav.flatMap((section) => section.items);

export function getNavContext(href: string) {
  const idx = flatNavItems.findIndex((item) => item.href === href);
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
        crumbs.push({ title: section.title, href: section.items[0].href });
        if (item.href !== section.items[0].href) {
          crumbs.push({ title: item.title, href: item.href });
        }
      }
      return crumbs;
    }
  }
  return [{ title: "Docs", href: "/docs" }];
}
