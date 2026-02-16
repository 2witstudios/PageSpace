import Link from "next/link";
import { Sparkles, ArrowRight, Book, Code, Zap, Server, FileText, Users, Terminal, ChevronRight, Search, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.docs;

interface DocSection {
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  items: { title: string; href: string }[];
}

const docSections: DocSection[] = [
  {
    title: "Getting Started",
    description: "Learn the basics of PageSpace and set up your first workspace.",
    icon: <Book className="h-5 w-5" />,
    href: "/docs/getting-started",
    items: [
      { title: "Quick Start Guide", href: "/docs/getting-started" },
      { title: "Creating Your First Workspace", href: "/docs/getting-started/workspace" },
      { title: "Understanding AI Agents", href: "/docs/getting-started/agents" },
      { title: "Keyboard Shortcuts", href: "/docs/getting-started/shortcuts" },
    ],
  },
  {
    title: "AI Features",
    description: "Deep dive into AI capabilities including Page Agents and Global Assistant.",
    icon: <Sparkles className="h-5 w-5" />,
    href: "/docs/ai",
    items: [
      { title: "Global Assistant", href: "/docs/ai/global-assistant" },
      { title: "Page Agents", href: "/docs/ai/page-agents" },
      { title: "AI Rollback", href: "/docs/ai/rollback" },
      { title: "Custom Prompts", href: "/docs/ai/prompts" },
    ],
  },
  {
    title: "Integrations",
    description: "Connect PageSpace to external tools and services.",
    icon: <Zap className="h-5 w-5" />,
    href: "/docs/integrations",
    items: [
      { title: "MCP Overview", href: "/docs/integrations/mcp" },
      { title: "Google Calendar", href: "/docs/integrations/google-calendar" },
      { title: "GitHub Integration", href: "/docs/integrations/github" },
      { title: "Webhooks", href: "/docs/integrations/webhooks" },
    ],
  },
  {
    title: "API Reference",
    description: "Full reference for the PageSpace REST API.",
    icon: <Code className="h-5 w-5" />,
    href: "/docs/api",
    items: [
      { title: "Authentication", href: "/docs/api/authentication" },
      { title: "Pages", href: "/docs/api/pages" },
      { title: "Workspaces", href: "/docs/api/workspaces" },
      { title: "AI Endpoints", href: "/docs/api/ai" },
    ],
  },
  {
    title: "MCP Servers",
    description: "Connect AI to external tools with Model Context Protocol.",
    icon: <Server className="h-5 w-5" />,
    href: "/docs/mcp",
    items: [
      { title: "What is MCP?", href: "/docs/mcp/overview" },
      { title: "Available Servers", href: "/docs/mcp/servers" },
      { title: "Building Custom Servers", href: "/docs/mcp/custom" },
      { title: "Security & Permissions", href: "/docs/mcp/security" },
    ],
  },
  {
    title: "Team & Collaboration",
    description: "Learn about team features, permissions, and real-time collaboration.",
    icon: <Users className="h-5 w-5" />,
    href: "/docs/teams",
    items: [
      { title: "Inviting Team Members", href: "/docs/teams/invites" },
      { title: "Permissions & Roles", href: "/docs/teams/permissions" },
      { title: "Channels", href: "/docs/teams/channels" },
      { title: "Task Assignment", href: "/docs/teams/tasks" },
    ],
  },
  {
    title: "Security & Privacy",
    description: "Authentication, data protection, and enterprise security features.",
    icon: <Shield className="h-5 w-5" />,
    href: "/docs/security",
    items: [
      { title: "Passkeys (WebAuthn)", href: "/docs/security/passkeys" },
      { title: "Magic Links", href: "/docs/security/magic-links" },
      { title: "Zero Trust Architecture", href: "/docs/security/zero-trust" },
      { title: "Data Encryption", href: "/docs/security/encryption" },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Sparkles className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-xl font-bold">PageSpace</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6">
            <Link href="/pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Pricing
            </Link>
            <Link href="/downloads" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Downloads
            </Link>
            <Link href="/docs" className="text-sm font-medium text-foreground transition-colors">
              Docs
            </Link>
            <Link href="/blog" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Blog
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
              <Link href="/login">Log in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/signup">Get Started</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Documentation
            </h1>
            <p className="text-lg text-muted-foreground mb-8">
              Everything you need to know about PageSpace—from getting started to advanced integrations.
            </p>

            {/* Search */}
            <div className="max-w-xl mx-auto">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search documentation..."
                  className="w-full rounded-xl border border-border bg-card pl-12 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <kbd className="absolute right-4 top-1/2 -translate-y-1/2 hidden sm:inline-flex h-6 items-center gap-1 rounded border border-border bg-muted px-2 text-xs text-muted-foreground">
                  <span>⌘</span>K
                </kbd>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Quick Links */}
      <section className="pb-8">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/docs/getting-started"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm hover:bg-muted transition-colors"
            >
              <Book className="h-4 w-4" />
              Quick Start
            </Link>
            <Link
              href="/docs/api"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm hover:bg-muted transition-colors"
            >
              <Terminal className="h-4 w-4" />
              API Reference
            </Link>
            <Link
              href="/docs/mcp"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm hover:bg-muted transition-colors"
            >
              <Server className="h-4 w-4" />
              MCP Servers
            </Link>
            <Link
              href="/changelog"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm hover:bg-muted transition-colors"
            >
              <FileText className="h-4 w-4" />
              Changelog
            </Link>
          </div>
        </div>
      </section>

      {/* Documentation Sections */}
      <section className="py-12 md:py-16">
        <div className="container mx-auto px-4 md:px-6">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {docSections.map((section) => (
              <div
                key={section.title}
                className="rounded-xl border border-border bg-card p-6 hover:border-primary/50 transition-colors"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    {section.icon}
                  </div>
                  <h2 className="text-lg font-semibold">{section.title}</h2>
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                  {section.description}
                </p>
                <ul className="space-y-2">
                  {section.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="flex items-center gap-2 text-sm hover:text-primary transition-colors group"
                      >
                        <ChevronRight className="h-3 w-3 text-muted-foreground group-hover:text-primary transition-colors" />
                        {item.title}
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link
                  href={section.href}
                  className="inline-flex items-center gap-1 text-sm text-primary mt-4 hover:underline"
                >
                  View all
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Popular Articles */}
      <section className="py-12 md:py-16 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-2xl font-bold mb-8 text-center">Popular Articles</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {[
                { title: "Quick Start Guide", description: "Get up and running in 5 minutes", href: "/docs/getting-started" },
                { title: "Understanding Page Agents", description: "Learn how AI agents work in your workspace", href: "/docs/ai/page-agents" },
                { title: "API Authentication", description: "Secure your API requests with tokens", href: "/docs/api/authentication" },
                { title: "MCP Server Setup", description: "Connect AI to external tools", href: "/docs/mcp/overview" },
              ].map((article) => (
                <Link
                  key={article.href}
                  href={article.href}
                  className="flex items-start gap-4 rounded-xl border border-border bg-card p-4 hover:border-primary/50 transition-colors"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted flex-shrink-0">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="font-medium mb-1">{article.title}</h3>
                    <p className="text-sm text-muted-foreground">{article.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Help Section */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold mb-4">Need more help?</h2>
            <p className="text-muted-foreground mb-6">
              Can&apos;t find what you&apos;re looking for? Check the FAQ or reach out to our support team.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button asChild>
                <Link href="/faq">
                  View FAQ
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/contact">
                  Contact Support
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter variant="compact" />
    </div>
  );
}
