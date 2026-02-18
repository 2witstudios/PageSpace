import Link from "next/link";
import { ArrowRight, Book, Sparkles, Server, Code2, Shield, HardDrive } from "lucide-react";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.docs;

const sections = [
  {
    title: "Getting Started",
    description: "Set up your workspace, understand core concepts, and explore all 9 page types.",
    icon: Book,
    href: "/docs/getting-started",
    links: [
      { title: "Quick Start", href: "/docs/getting-started" },
      { title: "Core Concepts", href: "/docs/core-concepts" },
      { title: "Page Types", href: "/docs/page-types" },
    ],
  },
  {
    title: "AI System",
    description: "Multi-provider AI with contextual intelligence, 13+ workspace tools, and agent collaboration.",
    icon: Sparkles,
    href: "/docs/ai",
    links: [
      { title: "AI Overview", href: "/docs/ai" },
      { title: "Providers & Models", href: "/docs/ai/providers" },
      { title: "Tool Calling", href: "/docs/ai/tool-calling" },
      { title: "Agents", href: "/docs/ai/agents" },
    ],
  },
  {
    title: "MCP Integration",
    description: "Connect external AI tools to PageSpace or add local MCP servers to the desktop app.",
    icon: Server,
    href: "/docs/mcp",
    links: [
      { title: "MCP Overview", href: "/docs/mcp" },
      { title: "Desktop MCP", href: "/docs/mcp/desktop" },
    ],
  },
  {
    title: "API Reference",
    description: "Complete REST API documentation for authentication, pages, drives, AI, and more.",
    icon: Code2,
    href: "/docs/api",
    links: [
      { title: "API Overview", href: "/docs/api" },
      { title: "Auth", href: "/docs/api/auth" },
      { title: "Pages", href: "/docs/api/pages" },
      { title: "Drives", href: "/docs/api/drives" },
      { title: "AI", href: "/docs/api/ai" },
    ],
  },
  {
    title: "Security & Auth",
    description: "Opaque session tokens, RBAC permissions, and zero-trust architecture.",
    icon: Shield,
    href: "/docs/security",
    links: [
      { title: "Overview", href: "/docs/security" },
      { title: "Authentication", href: "/docs/security/authentication" },
      { title: "Permissions", href: "/docs/security/permissions" },
      { title: "Zero-Trust", href: "/docs/security/zero-trust" },
    ],
  },
  {
    title: "Self-Hosting",
    description: "Deploy PageSpace on your own infrastructure with Docker, environment variables, and service architecture.",
    icon: HardDrive,
    href: "/docs/self-hosting",
    links: [
      { title: "Overview", href: "/docs/self-hosting" },
      { title: "Docker Setup", href: "/docs/self-hosting/docker" },
      { title: "Environment", href: "/docs/self-hosting/environment" },
      { title: "Architecture", href: "/docs/self-hosting/architecture" },
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
        Technical documentation for PageSpace — the AI-powered unified workspace. Covers the API, AI system, security model, self-hosting, and MCP integration.
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        {sections.map((section) => {
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
