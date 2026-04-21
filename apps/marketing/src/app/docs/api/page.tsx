import Link from "next/link";
import { ArrowRight, KeyRound, FileText, HardDrive, Sparkles, MessageSquare, Server, Search, UserCog, Bell } from "lucide-react";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "API Reference",
  description: "PageSpace REST API reference. Authentication, pages, drives, AI, channels, MCP, files, search, users, and admin endpoints.",
  path: "/docs/api",
  keywords: ["API", "REST", "endpoints", "reference", "integration"],
});

const domains = [
  { title: "Authentication", href: "/docs/api/auth", icon: KeyRound, description: "Passkeys, magic links, OAuth, sessions, CSRF, MCP tokens" },
  { title: "Pages", href: "/docs/api/pages", icon: FileText, description: "CRUD, hierarchy, permissions, bulk operations, agent config" },
  { title: "Drives", href: "/docs/api/drives", icon: HardDrive, description: "Workspaces, members, roles, integrations, trash, search" },
  { title: "AI", href: "/docs/api/ai", icon: Sparkles, description: "Chat streaming, settings, global conversations, page agents" },
  { title: "Channels", href: "/docs/api/channels", icon: MessageSquare, description: "Real-time messaging in channel pages" },
  { title: "MCP", href: "/docs/api/mcp", icon: Server, description: "Document and drive operations for MCP clients" },
  { title: "Files", href: "/docs/api/files", icon: FileText, description: "Upload, serving, processing status, conversion" },
  { title: "Search", href: "/docs/api/search", icon: Search, description: "Global search, multi-drive search, mentions" },
  { title: "Users", href: "/docs/api/users", icon: UserCog, description: "Account management, user search, connections" },
  { title: "Admin", href: "/docs/api/admin", icon: Bell, description: "User management, audit logs, monitoring, notifications" },
];

export default function ApiIndexPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight mb-4">API Reference</h1>
      <p className="text-lg text-muted-foreground mb-4">
        PageSpace exposes a REST API under <code className="bg-muted px-1.5 py-0.5 rounded text-xs">/api</code>. Routes live in <code className="bg-muted px-1.5 py-0.5 rounded text-xs">apps/web/src/app/api/</code> and are implemented as Next.js 15 route handlers.
      </p>
      <div className="text-sm text-muted-foreground mb-8 space-y-2">
        <p><strong>Base URL</strong>: <code className="bg-muted px-1.5 py-0.5 rounded text-xs">https://your-instance.com/api</code></p>
        <p><strong>Authentication</strong>: opaque session cookies (web) or <code className="bg-muted px-1.5 py-0.5 rounded text-xs">Authorization: Bearer mcp_...</code> (MCP). A handful of public routes — <code className="bg-muted px-1.5 py-0.5 rounded text-xs">/contact</code>, OAuth callbacks, magic-link initiation — require no session.</p>
        <p><strong>CSRF</strong>: state-changing routes require a CSRF token fetched from <code className="bg-muted px-1.5 py-0.5 rounded text-xs">GET /api/auth/csrf</code> and sent in the <code className="bg-muted px-1.5 py-0.5 rounded text-xs">x-csrf-token</code> header.</p>
        <p><strong>Content-Type</strong>: <code className="bg-muted px-1.5 py-0.5 rounded text-xs">application/json</code> except for uploads (<code className="bg-muted px-1.5 py-0.5 rounded text-xs">multipart/form-data</code>).</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {domains.map((domain) => {
          const Icon = domain.icon;
          return (
            <Link
              key={domain.href}
              href={domain.href}
              className="group rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <h2 className="font-semibold group-hover:text-primary transition-colors">{domain.title}</h2>
              </div>
              <p className="text-sm text-muted-foreground">{domain.description}</p>
              <span className="inline-flex items-center gap-1 text-xs text-primary mt-3 group-hover:underline">
                View routes <ArrowRight className="h-3 w-3" />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
