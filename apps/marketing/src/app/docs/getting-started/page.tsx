import Link from "next/link";
import { Sparkles, ArrowRight, ArrowLeft, CheckCircle2, ChevronRight, Play, Book, Zap, Code } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Getting Started | PageSpace Documentation",
  description: "Learn how to set up PageSpace and create your first AI-powered workspace in minutes.",
};

const steps = [
  {
    number: 1,
    title: "Create Your Account",
    description: "Sign up for a free PageSpace account. No credit card required.",
    details: [
      "Go to pagespace.ai/signup",
      "Enter your email and create a password",
      "Verify your email address",
      "You're ready to start!",
    ],
  },
  {
    number: 2,
    title: "Create Your First Workspace",
    description: "Workspaces are the foundation of PageSpace. They contain all your documents, channels, and tasks.",
    details: [
      "Click 'New Workspace' in the sidebar",
      "Give your workspace a name",
      "Choose a template or start blank",
      "Invite team members (optional)",
    ],
  },
  {
    number: 3,
    title: "Add Your First Document",
    description: "Documents in PageSpace come with AI assistance built in.",
    details: [
      "Click '+' to create a new page",
      "Start typing—AI suggestions appear automatically",
      "Highlight text to request AI edits",
      "Use the AI panel for longer conversations",
    ],
  },
  {
    number: 4,
    title: "Create a Page Agent",
    description: "Page Agents are specialized AI helpers with custom prompts.",
    details: [
      "Right-click in the file tree",
      "Select 'New Page Agent'",
      "Write a custom system prompt",
      "The agent inherits context from its location",
    ],
  },
  {
    number: 5,
    title: "Explore Channels and Tasks",
    description: "Collaborate with your team using channels and manage work with tasks.",
    details: [
      "Create channels for team discussions",
      "@mention AI agents in any conversation",
      "Create tasks and assign to humans or AI",
      "Track progress with smart rollups",
    ],
  },
];

export default function GettingStartedPage() {
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

      {/* Breadcrumb */}
      <div className="border-b border-border">
        <div className="container mx-auto px-4 md:px-6 py-4">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/docs" className="text-muted-foreground hover:text-foreground transition-colors">
              Docs
            </Link>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
            <span className="text-foreground">Getting Started</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 md:px-6 py-12">
        <div className="max-w-4xl mx-auto">
          {/* Back Link */}
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Documentation
          </Link>

          {/* Header */}
          <div className="mb-12">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Play className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-3xl md:text-4xl font-bold">Getting Started</h1>
            </div>
            <p className="text-lg text-muted-foreground">
              Learn how to set up PageSpace and create your first AI-powered workspace in minutes.
            </p>
          </div>

          {/* Video Placeholder */}
          <div className="rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 h-64 md:h-80 flex items-center justify-center mb-12 border border-border">
            <div className="text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/20 mx-auto mb-4">
                <Play className="h-8 w-8 text-primary" />
              </div>
              <p className="text-muted-foreground">Video tutorial coming soon</p>
            </div>
          </div>

          {/* Steps */}
          <div className="space-y-12">
            {steps.map((step) => (
              <div key={step.number} className="relative">
                <div className="flex gap-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold flex-shrink-0">
                    {step.number}
                  </div>
                  <div className="flex-1">
                    <h2 className="text-xl font-semibold mb-2">{step.title}</h2>
                    <p className="text-muted-foreground mb-4">{step.description}</p>
                    <ul className="space-y-2">
                      {step.details.map((detail, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                          <span>{detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Next Steps */}
          <div className="mt-16 pt-12 border-t border-border">
            <h2 className="text-2xl font-bold mb-6">What&apos;s Next?</h2>
            <div className="grid md:grid-cols-3 gap-4">
              <Link
                href="/docs/ai/page-agents"
                className="rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors"
              >
                <Book className="h-6 w-6 text-primary mb-3" />
                <h3 className="font-semibold mb-1">Page Agents Deep Dive</h3>
                <p className="text-sm text-muted-foreground">Learn advanced Page Agent techniques</p>
              </Link>
              <Link
                href="/docs/integrations"
                className="rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors"
              >
                <Zap className="h-6 w-6 text-primary mb-3" />
                <h3 className="font-semibold mb-1">Connect Integrations</h3>
                <p className="text-sm text-muted-foreground">Link your tools and services</p>
              </Link>
              <Link
                href="/docs/api"
                className="rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors"
              >
                <Code className="h-6 w-6 text-primary mb-3" />
                <h3 className="font-semibold mb-1">API Reference</h3>
                <p className="text-sm text-muted-foreground">Build with the PageSpace API</p>
              </Link>
            </div>
          </div>

          {/* CTA */}
          <div className="mt-16 rounded-2xl bg-primary/5 border border-primary/20 p-8 text-center">
            <h2 className="text-xl font-bold mb-2">Ready to get started?</h2>
            <p className="text-muted-foreground mb-6">Create your free account and start building.</p>
            <Button size="lg" asChild>
              <Link href="/signup">
                Create Free Account
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-12 mt-12">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                <Sparkles className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="font-semibold">PageSpace</span>
            </div>
            <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
              <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
              <Link href="/downloads" className="hover:text-foreground transition-colors">Downloads</Link>
              <Link href="/blog" className="hover:text-foreground transition-colors">Blog</Link>
              <Link href="/changelog" className="hover:text-foreground transition-colors">Changelog</Link>
            </nav>
            <p className="text-sm text-muted-foreground">
              &copy; {new Date().getFullYear()} PageSpace. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
