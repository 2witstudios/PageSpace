import Link from "next/link";
import { Sparkles, ArrowRight, Zap, Bug, Star, Wrench, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata, APP_URL } from "@/lib/metadata";

export const metadata = pageMetadata.changelog;

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  description: string;
  changes: {
    type: "feature" | "improvement" | "fix" | "breaking";
    text: string;
  }[];
}

const changelog: ChangelogEntry[] = [
  {
    version: "2.5.0",
    date: "2026-02-14",
    title: "Security Hardening & Per-Event Authorization",
    description: "Enhanced security with per-event WebSocket authorization, distributed rate limiting, and improved session management.",
    changes: [
      { type: "feature", text: "Per-event WebSocket authorization for all write operations" },
      { type: "feature", text: "Distributed rate limiting with database-backed account lockout" },
      { type: "feature", text: "HMAC-signed inter-service broadcast authentication" },
      { type: "improvement", text: "Opaque session tokens with hash-only storage" },
      { type: "improvement", text: "Enhanced CSRF protection with timing-safe validation" },
      { type: "improvement", text: "Security event logging for audit trails" },
    ],
  },
  {
    version: "2.4.0",
    date: "2026-02-10",
    title: "Page Agents & MCP Integration",
    description: "Introducing Page Agents—specialized AI helpers that live in your file tree—and expanded MCP server support.",
    changes: [
      { type: "feature", text: "Page Agents with custom prompts and hierarchical context" },
      { type: "feature", text: "MCP server integration for external tool access" },
      { type: "feature", text: "Google Calendar two-way sync" },
      { type: "improvement", text: "Faster AI response times with streaming improvements" },
      { type: "improvement", text: "Updated AI models to latest versions" },
      { type: "fix", text: "Fixed document sync issues in slow network conditions" },
    ],
  },
  {
    version: "2.3.0",
    date: "2026-01-28",
    title: "AI Rollback & Version History",
    description: "One-click rollback for all AI changes, plus improved version history across the platform.",
    changes: [
      { type: "feature", text: "AI Rollback: Undo any AI change with one click" },
      { type: "feature", text: "Version history timeline for all documents" },
      { type: "feature", text: "Compare versions side-by-side" },
      { type: "improvement", text: "Better AI suggestions in document editor" },
      { type: "improvement", text: "Reduced memory usage on desktop apps" },
      { type: "fix", text: "Fixed keyboard shortcuts on Windows" },
      { type: "fix", text: "Fixed image upload in channels" },
    ],
  },
  {
    version: "2.2.0",
    date: "2026-01-15",
    title: "Channels & Real-time Collaboration",
    description: "Public and private channels for team communication, with full AI agent integration.",
    changes: [
      { type: "feature", text: "Public and private channels" },
      { type: "feature", text: "@mention AI agents in channel conversations" },
      { type: "feature", text: "Threaded replies for organized discussions" },
      { type: "improvement", text: "Real-time presence indicators" },
      { type: "improvement", text: "Improved mobile app performance" },
      { type: "fix", text: "Fixed notification delivery on iOS" },
    ],
  },
  {
    version: "2.1.0",
    date: "2026-01-02",
    title: "Tasks & Smart Rollups",
    description: "Assign tasks to AI or humans, with automatic progress tracking and smart rollups.",
    changes: [
      { type: "feature", text: "Task lists as first-class pages" },
      { type: "feature", text: "Assign tasks to AI agents for autonomous work" },
      { type: "feature", text: "Smart rollups across workspaces" },
      { type: "feature", text: "Task deadlines in calendar view" },
      { type: "improvement", text: "Better drag-and-drop in file tree" },
      { type: "fix", text: "Fixed search indexing for new documents" },
    ],
  },
  {
    version: "2.0.0",
    date: "2025-12-15",
    title: "PageSpace 2.0",
    description: "A major update introducing the Global Assistant, new document editor, and refreshed UI.",
    changes: [
      { type: "feature", text: "Global Assistant: Personal AI across all workspaces" },
      { type: "feature", text: "New document editor with inline AI assistance" },
      { type: "feature", text: "Calendar view with Google Calendar integration" },
      { type: "feature", text: "Desktop apps for macOS, Windows, and Linux" },
      { type: "improvement", text: "Complete UI refresh with dark mode" },
      { type: "improvement", text: "50% faster page load times" },
      { type: "breaking", text: "API v1 deprecated (v2 now default)" },
    ],
  },
];

function getChangeIcon(type: string) {
  switch (type) {
    case "feature":
      return <Star className="h-4 w-4 text-yellow-500" />;
    case "improvement":
      return <Zap className="h-4 w-4 text-blue-500" />;
    case "fix":
      return <Bug className="h-4 w-4 text-green-500" />;
    case "breaking":
      return <Wrench className="h-4 w-4 text-red-500" />;
    default:
      return <ChevronRight className="h-4 w-4 text-muted-foreground" />;
  }
}

function getChangeLabel(type: string) {
  switch (type) {
    case "feature":
      return "New";
    case "improvement":
      return "Improved";
    case "fix":
      return "Fixed";
    case "breaking":
      return "Breaking";
    default:
      return type;
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function ChangelogPage() {
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
            <Link href="/docs" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Docs
            </Link>
            <Link href="/blog" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Blog
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
              <a href={`${APP_URL}/auth/signin`}>Log in</a>
            </Button>
            <Button size="sm" asChild>
              <a href={`${APP_URL}/auth/signup`}>Get Started</a>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Changelog
            </h1>
            <p className="text-lg text-muted-foreground">
              New features, improvements, and fixes. See what&apos;s new in PageSpace.
            </p>
          </div>
        </div>
      </section>

      {/* Legend */}
      <section className="pb-8">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <Star className="h-4 w-4 text-yellow-500" />
              <span>New Feature</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-blue-500" />
              <span>Improvement</span>
            </div>
            <div className="flex items-center gap-2">
              <Bug className="h-4 w-4 text-green-500" />
              <span>Bug Fix</span>
            </div>
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-red-500" />
              <span>Breaking Change</span>
            </div>
          </div>
        </div>
      </section>

      {/* Changelog Entries */}
      <section className="py-12 md:py-16">
        <div className="container mx-auto px-4 md:px-6">
          <div className="max-w-3xl mx-auto">
            {changelog.map((entry, index) => (
              <div
                key={entry.version}
                className={`relative pb-12 ${index < changelog.length - 1 ? "border-l-2 border-border ml-4 pl-8" : "ml-4 pl-8"}`}
              >
                {/* Timeline dot */}
                <div className="absolute -left-[9px] top-0 h-4 w-4 rounded-full bg-primary" />

                {/* Version header */}
                <div className="mb-4">
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-primary text-primary-foreground">
                      v{entry.version}
                    </span>
                    <span className="text-sm text-muted-foreground">{formatDate(entry.date)}</span>
                  </div>
                  <h2 className="text-2xl font-bold mb-2">{entry.title}</h2>
                  <p className="text-muted-foreground">{entry.description}</p>
                </div>

                {/* Changes */}
                <ul className="space-y-3">
                  {entry.changes.map((change, i) => (
                    <li key={i} className="flex items-start gap-3">
                      {getChangeIcon(change.type)}
                      <span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mr-2 ${
                          change.type === "feature" ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" :
                          change.type === "improvement" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" :
                          change.type === "fix" ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" :
                          "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                        }`}>
                          {getChangeLabel(change.type)}
                        </span>
                        {change.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Subscribe */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold mb-4">Stay in the loop</h2>
            <p className="text-muted-foreground mb-6">
              Subscribe to get notified when we release new features and improvements.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
              <input
                type="email"
                placeholder="Enter your email"
                className="flex-1 rounded-lg border border-border bg-background px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <Button>
                Subscribe
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter variant="compact" />
    </div>
  );
}
