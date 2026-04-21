import {
  Book,
  Sparkles,
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
  Bot,
  Layers,
  Plug,
  Calendar,
  Github,
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
    ],
  },
  {
    title: "Page Types",
    icon: LayoutGrid,
    items: [
      { title: "Overview", href: "/docs/page-types", icon: LayoutGrid },
      { title: "Document", href: "/docs/page-types/document", icon: FileText },
      { title: "Folder", href: "/docs/page-types/folder", icon: Folder },
      { title: "AI Chat", href: "/docs/page-types/ai-chat", icon: Bot },
      { title: "Channel", href: "/docs/page-types/channel", icon: MessageSquare },
      { title: "Sheet", href: "/docs/page-types/sheet", icon: Table },
      { title: "Canvas", href: "/docs/page-types/canvas", icon: Palette },
      { title: "Code", href: "/docs/page-types/code", icon: Code },
      { title: "Task List", href: "/docs/page-types/task-list", icon: ListChecks },
      { title: "File", href: "/docs/page-types/file", icon: Upload },
    ],
  },
  {
    title: "Features",
    icon: Lightbulb,
    items: [
      { title: "Overview", href: "/docs/features", icon: Lightbulb },
      { title: "Pages", href: "/docs/features/pages", icon: Layers },
      { title: "Drives & Workspaces", href: "/docs/features/drives", icon: HardDrive },
      { title: "AI in your Workspace", href: "/docs/features/ai", icon: Sparkles },
      { title: "Sharing & Permissions", href: "/docs/features/sharing", icon: Users },
      { title: "Search", href: "/docs/features/search", icon: Search },
      { title: "Accounts & Sign In", href: "/docs/features/accounts", icon: KeyRound },
    ],
  },
  {
    title: "Integrations",
    icon: Plug,
    items: [
      { title: "Overview", href: "/docs/integrations", icon: Plug },
      { title: "Google Calendar", href: "/docs/integrations/google-calendar", icon: Calendar },
      { title: "GitHub", href: "/docs/integrations/github", icon: Github },
      { title: "MCP", href: "/docs/integrations/mcp", icon: Server },
      { title: "Desktop MCP", href: "/docs/integrations/mcp/desktop", icon: Monitor },
    ],
  },
  {
    title: "Security & Trust",
    icon: Shield,
    items: [
      { title: "Overview", href: "/docs/security", icon: Shield },
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
