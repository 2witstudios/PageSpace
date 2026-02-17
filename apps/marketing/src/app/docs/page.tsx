import Link from "next/link";
import { Sparkles, ArrowRight, Book, Zap, Server, FileText, Users, ChevronRight, Search, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.docs;

interface DocItem {
  title: string;
  href?: string;
  comingSoon?: boolean;
}

interface DocSection {
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  items: DocItem[];
}

const docSections: DocSection[] = [
  {
    title: "Getting Started",
    description: "Learn the basics of PageSpace and set up your first workspace.",
    icon: <Book className="h-5 w-5" />,
    href: "/docs/getting-started",
    items: [
      { title: "Quick Start Guide", href: "/docs/getting-started" },
      { title: "Creating Your First Workspace", href: "/docs/getting-started" },
      { title: "Understanding AI Agents", comingSoon: true },
      { title: "Keyboard Shortcuts", comingSoon: true },
    ],
  },
  {
    title: "AI Features",
    description: "Deep dive into AI capabilities including Page Agents and Global Assistant.",
    icon: <Sparkles className="h-5 w-5" />,
    href: "/docs",
    items: [
      { title: "Global Assistant", comingSoon: true },
      { title: "Page Agents", comingSoon: true },
      { title: "AI Rollback", comingSoon: true },
      { title: "Custom Prompts", comingSoon: true },
    ],
  },
  {
    title: "Integrations",
    description: "Connect PageSpace to external tools and services.",
    icon: <Zap className="h-5 w-5" />,
    href: "/docs",
    items: [
      { title: "MCP Overview", comingSoon: true },
      { title: "Google Calendar", comingSoon: true },
      { title: "GitHub Integration", comingSoon: true },
      { title: "Webhooks", comingSoon: true },
    ],
  },
  {
    title: "MCP Servers",
    description: "Connect AI to external tools with Model Context Protocol.",
    icon: <Server className="h-5 w-5" />,
    href: "/docs",
    items: [
      { title: "What is MCP?", comingSoon: true },
      { title: "Available Servers", comingSoon: true },
      { title: "Building Custom Servers", comingSoon: true },
      { title: "Security & Permissions", comingSoon: true },
    ],
  },
  {
    title: "Team & Collaboration",
    description: "Learn about team features, permissions, and real-time collaboration.",
    icon: <Users className="h-5 w-5" />,
    href: "/docs",
    items: [
      { title: "Inviting Team Members", comingSoon: true },
      { title: "Permissions & Roles", comingSoon: true },
      { title: "Channels", comingSoon: true },
      { title: "Task Assignment", comingSoon: true },
    ],
  },
  {
    title: "Security & Privacy",
    description: "Authentication, data protection, and enterprise security features.",
    icon: <Shield className="h-5 w-5" />,
    href: "/docs",
    items: [
      { title: "Passkeys (WebAuthn)", comingSoon: true },
      { title: "Magic Links", comingSoon: true },
      { title: "Zero Trust Architecture", comingSoon: true },
      { title: "Data Encryption", comingSoon: true },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

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
                <button
                  type="button"
                  className="w-full rounded-xl border border-border bg-card pl-12 pr-4 py-3 text-sm text-left text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  Search documentation...
                </button>
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
              href="/docs"
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
                    <li key={item.title}>
                      {item.comingSoon ? (
                        <span className="flex items-center gap-2 text-sm text-muted-foreground/70 cursor-default">
                          <ChevronRight className="h-3 w-3" />
                          {item.title}
                        </span>
                      ) : (
                        <Link
                          href={item.href!}
                          className="flex items-center gap-2 text-sm hover:text-primary transition-colors group"
                        >
                          <ChevronRight className="h-3 w-3 text-muted-foreground group-hover:text-primary transition-colors" />
                          {item.title}
                        </Link>
                      )}
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
                { title: "Understanding Page Agents", description: "Learn how AI agents work in your workspace", href: "/docs" },
                { title: "Setting Up MCP Servers", description: "Connect AI to external tools and services", href: "/docs" },
              ].map((article) => (
                <Link
                  key={article.title}
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
