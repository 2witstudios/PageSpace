import Link from "next/link";
import { ArrowRight, Book, LayoutGrid, Lightbulb, Plug, Shield } from "lucide-react";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.docs;

const referenceSections = [
  {
    title: "Page Types",
    description: "The 9 built-in page types at a glance — documents, folders, AI chats, channels, sheets, canvases, code, task lists, and files.",
    icon: LayoutGrid,
    href: "/docs/page-types",
    links: [
      { title: "Overview", href: "/docs/page-types" },
      { title: "Document", href: "/docs/page-types/document" },
      { title: "AI Chat", href: "/docs/page-types/ai-chat" },
      { title: "Channel", href: "/docs/page-types/channel" },
    ],
  },
  {
    title: "Features",
    description: "How the behaviours every page shares actually work — pages, drives, AI, sharing, search, and accounts.",
    icon: Lightbulb,
    href: "/docs/features",
    links: [
      { title: "Pages", href: "/docs/features/pages" },
      { title: "AI in your Workspace", href: "/docs/features/ai" },
      { title: "Sharing & Permissions", href: "/docs/features/sharing" },
      { title: "Drives & Workspaces", href: "/docs/features/drives" },
    ],
  },
  {
    title: "Integrations",
    description: "Connect Claude Desktop, Cursor, or your own MCP client to your PageSpace workspace.",
    icon: Plug,
    href: "/docs/integrations",
    links: [
      { title: "Overview", href: "/docs/integrations" },
      { title: "MCP", href: "/docs/integrations/mcp" },
      { title: "Desktop MCP", href: "/docs/integrations/mcp/desktop" },
    ],
  },
  {
    title: "Security & Trust",
    description: "How authentication, permissions, and session handling work — for procurement and curious users.",
    icon: Shield,
    href: "/docs/security",
    links: [
      { title: "Overview", href: "/docs/security" },
      { title: "Authentication", href: "/docs/security/authentication" },
      { title: "Permissions", href: "/docs/security/permissions" },
      { title: "Zero-Trust", href: "/docs/security/zero-trust" },
    ],
  },
];

export default function DocsPage() {
  return (
    <div>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
        Documentation
      </h1>
      <p className="text-lg text-muted-foreground mb-10">
        How PageSpace works, how to use it, how to connect your AI tools to it, and how we handle your data.
      </p>

      <div className="relative rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-8 mb-6 overflow-hidden">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Book className="h-5 w-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-0.5">Start here</div>
            <h2 className="text-xl font-semibold">Getting Started</h2>
          </div>
        </div>
        <p className="text-muted-foreground mb-4 max-w-2xl">
          New to PageSpace? Set up your workspace, learn the core concepts, and meet the page types that make everything tick.
        </p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <Link
            href="/docs/getting-started"
            className="group inline-flex items-center gap-1.5 font-medium text-primary hover:gap-2 transition-all"
          >
            Quick Start <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            href="/docs/core-concepts"
            className="text-muted-foreground hover:text-primary transition-colors"
          >
            Core Concepts
          </Link>
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        {referenceSections.map((section) => {
          const Icon = section.icon;
          return (
            <div
              key={section.title}
              className="rounded-xl border border-border bg-card p-6 hover:border-primary/50 transition-colors"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4.5 w-4.5" />
                </div>
                <h2 className="text-lg font-semibold">{section.title}</h2>
              </div>
              <p className="text-sm text-muted-foreground mb-4">{section.description}</p>
              <ul className="space-y-1.5">
                {section.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
                    >
                      <ArrowRight className="h-3 w-3" />
                      {link.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
