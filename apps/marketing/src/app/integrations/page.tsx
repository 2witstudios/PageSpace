import Link from "next/link";
import { ArrowRight, Plug, Server, Globe, Code, Database, Calendar, Mail, Github, FileText, Zap, ExternalLink, Terminal, Bot, Blocks, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";

export const metadata = pageMetadata.integrations;

interface MCPServer {
  name: string;
  description: string;
  icon: React.ReactNode;
  category: string;
  status: "available" | "coming-soon";
}

const mcpServers: MCPServer[] = [
  {
    name: "Filesystem",
    description: "Read, write, and manage files on your local system with AI assistance.",
    icon: <FileText className="h-5 w-5" />,
    category: "Core",
    status: "available",
  },
  {
    name: "GitHub",
    description: "Create issues, PRs, search repositories, and manage your codebase.",
    icon: <Github className="h-5 w-5" />,
    category: "Development",
    status: "available",
  },
  {
    name: "PostgreSQL",
    description: "Query databases, run migrations, and analyze your data.",
    icon: <Database className="h-5 w-5" />,
    category: "Data",
    status: "available",
  },
  {
    name: "Slack",
    description: "Send messages, search channels, and automate team communication.",
    icon: <Mail className="h-5 w-5" />,
    category: "Communication",
    status: "available",
  },
  {
    name: "Google Calendar",
    description: "Create events, check availability, and manage your schedule.",
    icon: <Calendar className="h-5 w-5" />,
    category: "Productivity",
    status: "available",
  },
  {
    name: "Web Search",
    description: "Search the web and bring real-time information into your workspace.",
    icon: <Globe className="h-5 w-5" />,
    category: "Research",
    status: "available",
  },
];

interface Integration {
  name: string;
  description: string;
  icon: React.ReactNode;
  type: "native" | "api" | "webhook";
}

const integrations: Integration[] = [
  {
    name: "Google Calendar",
    description: "Two-way sync with your Google Calendar. See events, deadlines, and AI work sessions together.",
    icon: <Calendar className="h-6 w-6 text-blue-500" />,
    type: "native",
  },
  {
    name: "GitHub",
    description: "Link repositories, track issues, and let AI help with code review and documentation.",
    icon: <Github className="h-6 w-6" />,
    type: "native",
  },
  {
    name: "Webhooks",
    description: "Connect PageSpace to any service with custom webhooks and event triggers.",
    icon: <Zap className="h-6 w-6 text-yellow-500" />,
    type: "webhook",
  },
  {
    name: "REST API",
    description: "Full programmatic access to workspaces, pages, and AI capabilities.",
    icon: <Code className="h-6 w-6 text-green-500" />,
    type: "api",
  },
];

export default function IntegrationsPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
              <Plug className="h-4 w-4 text-primary" />
              <span className="text-muted-foreground">Integrations</span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Connect your tools
            </h1>
            <p className="text-lg text-muted-foreground mb-8">
              PageSpace integrates with the tools you already use through MCP servers,
              native integrations, and a powerful API. Let AI work across your entire workflow.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" asChild>
                <Link href="/docs">
                  View Documentation
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href={`${APP_URL}/auth/signup`}>
                  Try It Free
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* MCP Servers Section */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="text-center mb-12">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                <Server className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-3xl font-bold mb-4">MCP Servers</h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Model Context Protocol (MCP) servers give AI direct access to external tools and data.
                Install servers to expand what your AI agents can do.
              </p>
            </div>

            {/* MCP Architecture Explainer */}
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8 mb-8">
              <div className="flex flex-col md:flex-row items-start gap-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 flex-shrink-0">
                  <Blocks className="h-6 w-6 text-primary" />
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-semibold mb-2">What is MCP?</h3>
                  <p className="text-muted-foreground mb-4">
                    MCP is an open protocol that lets AI models interact with external systems safely.
                    Instead of copy-pasting data, your AI can directly query databases, manage files, or interact with APIs—all within your workspace.
                  </p>
                  <div className="flex items-center gap-4 text-sm">
                    <a
                      href="https://modelcontextprotocol.io"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Learn about MCP
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <Link href="/docs" className="inline-flex items-center gap-1 text-primary hover:underline">
                      Setup guide
                      <ChevronRight className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              </div>
            </div>

            {/* MCP Server Grid */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {mcpServers.map((server) => (
                <div
                  key={server.name}
                  className="rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      {server.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold">{server.name}</h3>
                        {server.status === "available" ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                            Available
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                            Coming Soon
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">{server.description}</p>
                      <span className="inline-block mt-2 text-xs text-muted-foreground/70">{server.category}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="text-center mt-8">
              <Button variant="outline" asChild>
                <Link href="/docs">
                  Browse All MCP Servers
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Native Integrations Section */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="text-center mb-12">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                <Zap className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-3xl font-bold mb-4">Native Integrations</h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Deep integrations with popular tools that sync automatically
                and work seamlessly with your AI agents.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {integrations.map((integration) => (
                <div
                  key={integration.name}
                  className="rounded-2xl border border-border bg-card p-6 hover:shadow-lg transition-shadow"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                      {integration.icon}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="text-lg font-semibold">{integration.name}</h3>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground capitalize">
                          {integration.type}
                        </span>
                      </div>
                      <p className="text-muted-foreground">{integration.description}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Developer Section */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-4xl">
            <div className="rounded-2xl border border-border bg-card p-8 md:p-12">
              <div className="flex flex-col lg:flex-row items-start gap-8">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                      <Terminal className="h-6 w-6 text-primary" />
                    </div>
                    <h2 className="text-2xl font-bold">Build with PageSpace</h2>
                  </div>
                  <p className="text-muted-foreground mb-6">
                    Use our REST API to build custom integrations, automate workflows,
                    or create entirely new applications powered by PageSpace.
                  </p>

                  {/* Code Preview */}
                  <div className="rounded-lg bg-muted/50 p-4 font-mono text-sm mb-6 overflow-x-auto">
                    <div className="text-muted-foreground"># Create a new document with AI</div>
                    <div className="mt-2">
                      <span className="text-green-600 dark:text-green-400">curl</span> -X POST https://api.pagespace.ai/v1/pages \
                    </div>
                    <div className="pl-4">
                      -H &quot;Authorization: Bearer $API_KEY&quot; \
                    </div>
                    <div className="pl-4">
                      -d &apos;&#123;&quot;title&quot;: &quot;Meeting Notes&quot;, &quot;ai_assist&quot;: true&#125;&apos;
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-4">
                    <Button asChild>
                      <Link href="/docs">
                        API Documentation
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                    <Button variant="outline" asChild>
                      <Link href="/docs">
                        Build Custom MCP Server
                      </Link>
                    </Button>
                  </div>
                </div>

                <div className="lg:w-64 w-full space-y-4">
                  <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Resources</h3>
                  <div className="space-y-3">
                    <Link
                      href="/docs"
                      className="flex items-center gap-2 text-sm hover:text-primary transition-colors"
                    >
                      <Code className="h-4 w-4" />
                      API Reference
                    </Link>
                    <Link
                      href="/docs"
                      className="flex items-center gap-2 text-sm hover:text-primary transition-colors"
                    >
                      <Blocks className="h-4 w-4" />
                      SDK Libraries
                    </Link>
                    <Link
                      href="/docs"
                      className="flex items-center gap-2 text-sm hover:text-primary transition-colors"
                    >
                      <Zap className="h-4 w-4" />
                      Webhook Events
                    </Link>
                    <a
                      href="https://github.com/pagespace"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm hover:text-primary transition-colors"
                    >
                      <Github className="h-4 w-4" />
                      GitHub Examples
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-3xl font-bold mb-4">Ready to connect your tools?</h2>
            <p className="text-lg text-muted-foreground mb-8">
              Start with our generous free tier. Add integrations as you grow.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" asChild>
                <a href={`${APP_URL}/auth/signup`}>
                  Get Started Free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/docs">
                  Integration Quickstart
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
