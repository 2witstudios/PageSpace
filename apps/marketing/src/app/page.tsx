import Link from "next/link";
import { ArrowRight, Download, Sparkles, Users, Brain, FileText, MessageSquare, CheckSquare, Calendar, FolderTree, Bot, Globe, Layers, User, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pageMetadata } from "@/lib/metadata";
import { JsonLd, webApplicationSchema } from "@/lib/schema";

export const metadata = pageMetadata.home;

export default function Home() {
  return (
    <>
      <JsonLd data={webApplicationSchema} />
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
                <Link href="/login">Log in</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/signup">Get Started</Link>
              </Button>
            </div>
          </div>
        </header>

        {/* Hero Section */}
        <section className="relative overflow-hidden">
          {/* Background gradient */}
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.3),rgba(255,255,255,0))]" />

          <div className="container mx-auto px-4 md:px-6 py-16 md:py-24 lg:py-32">
            <div className="mx-auto max-w-4xl text-center">
              {/* Badge */}
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
                <Brain className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">AI-native workspace</span>
              </div>

              {/* Headline */}
              <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
                You, your team, and AI—
                <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                  {" "}working together
                </span>
              </h1>

              {/* Subheadline */}
              <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground md:text-xl">
                A unified workspace where AI agents live alongside your documents, tasks, and conversations.
                Not a chatbot—an intelligent collaborator that understands your entire workspace.
              </p>

              {/* CTAs */}
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
                <Button size="lg" asChild className="w-full sm:w-auto">
                  <Link href="/signup">
                    Get Started Free
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
                  <Link href="/pricing">
                    View Pricing
                  </Link>
                </Button>
              </div>

              {/* App availability */}
              <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
                <Link href="/downloads" className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors">
                  <Download className="h-4 w-4" />
                  <span>Mac, Windows, Linux</span>
                </Link>
                <span className="text-border">|</span>
                <span className="inline-flex items-center gap-1.5">
                  <span>iOS & Android</span>
                  <span className="text-xs bg-muted px-1.5 py-0.5 rounded">Beta</span>
                </span>
              </div>
            </div>

            {/* Hero Image/Preview Placeholder */}
            <div className="mt-16 md:mt-24">
              <div className="mx-auto max-w-6xl">
                <div className="relative rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
                  {/* Browser chrome */}
                  <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
                    <div className="flex gap-1.5">
                      <div className="h-3 w-3 rounded-full bg-red-400/80" />
                      <div className="h-3 w-3 rounded-full bg-yellow-400/80" />
                      <div className="h-3 w-3 rounded-full bg-green-400/80" />
                    </div>
                    <div className="flex-1 text-center">
                      <div className="inline-flex items-center gap-2 rounded-md bg-muted px-3 py-1 text-xs text-muted-foreground">
                        <span>app.pagespace.ai</span>
                      </div>
                    </div>
                  </div>

                  {/* App preview - simplified UI mockup */}
                  <div className="flex h-[400px] md:h-[500px] lg:h-[600px]">
                    {/* Sidebar */}
                    <div className="hidden sm:flex w-56 flex-col border-r border-border bg-muted/20 p-4">
                      <div className="flex items-center gap-2 mb-6">
                        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Users className="h-4 w-4 text-primary" />
                        </div>
                        <span className="text-sm font-medium">My Workspace</span>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm">
                          <FileText className="h-4 w-4 text-primary" />
                          <span>Documents</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50">
                          <MessageSquare className="h-4 w-4" />
                          <span>Channels</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50">
                          <CheckSquare className="h-4 w-4" />
                          <span>Tasks</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50">
                          <Calendar className="h-4 w-4" />
                          <span>Calendar</span>
                        </div>
                      </div>
                      <div className="mt-auto pt-4 border-t border-border">
                        <div className="flex items-center gap-2 rounded-md bg-gradient-to-r from-primary/20 to-primary/5 px-3 py-2 text-sm">
                          <Brain className="h-4 w-4 text-primary" />
                          <span className="font-medium">AI Assistant</span>
                        </div>
                      </div>
                    </div>

                    {/* Main content */}
                    <div className="flex-1 flex flex-col">
                      <div className="border-b border-border px-6 py-4">
                        <h2 className="text-lg font-semibold">Q1 Planning Document</h2>
                        <p className="text-sm text-muted-foreground">Last edited 2 minutes ago</p>
                      </div>
                      <div className="flex-1 p-6 space-y-4">
                        <div className="h-4 w-3/4 rounded bg-muted/50 animate-pulse" />
                        <div className="h-4 w-full rounded bg-muted/50 animate-pulse" />
                        <div className="h-4 w-5/6 rounded bg-muted/50 animate-pulse" />
                        <div className="h-4 w-2/3 rounded bg-muted/50 animate-pulse" />
                        <div className="h-20 w-full rounded-lg border border-primary/20 bg-primary/5 p-4 mt-6">
                          <div className="flex items-center gap-2 mb-2">
                            <Sparkles className="h-4 w-4 text-primary" />
                            <span className="text-sm font-medium text-primary">AI Suggestion</span>
                          </div>
                          <div className="h-3 w-5/6 rounded bg-primary/20 animate-pulse" />
                        </div>
                      </div>
                    </div>

                    {/* AI Panel */}
                    <div className="hidden lg:flex w-72 flex-col border-l border-border bg-muted/10 p-4">
                      <div className="flex items-center gap-2 mb-4">
                        <Brain className="h-5 w-5 text-primary" />
                        <span className="font-medium">AI Assistant</span>
                      </div>
                      <div className="space-y-3">
                        <div className="rounded-lg bg-muted p-3 text-sm">
                          <p className="text-muted-foreground">How can I help with your Q1 planning?</p>
                        </div>
                        <div className="rounded-lg bg-primary/10 p-3 text-sm ml-4">
                          <p>Summarize the key objectives we discussed</p>
                        </div>
                        <div className="rounded-lg bg-muted p-3 text-sm">
                          <div className="flex items-center gap-1 mb-1">
                            <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                            <span className="text-xs text-muted-foreground">Thinking...</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features Preview - Brief section to connect to rest of page */}
        <section className="border-t border-border bg-muted/30 py-16 md:py-24">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              <div className="text-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                  <FileText className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-1">Documents</h3>
                <p className="text-sm text-muted-foreground">AI-assisted editing</p>
              </div>
              <div className="text-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                  <MessageSquare className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-1">Channels</h3>
                <p className="text-sm text-muted-foreground">Team + AI messaging</p>
              </div>
              <div className="text-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                  <CheckSquare className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-1">Tasks</h3>
                <p className="text-sm text-muted-foreground">Assign to AI or humans</p>
              </div>
              <div className="text-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                  <Calendar className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold mb-1">Calendar</h3>
                <p className="text-sm text-muted-foreground">Unified view</p>
              </div>
            </div>
          </div>
        </section>

        {/* AI Architecture Section */}
        <section className="py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
                <Layers className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">AI Architecture</span>
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                AI that lives in your workspace
              </h2>
              <p className="text-lg text-muted-foreground">
                Not just a chatbot. PageSpace AI agents are part of your file tree,
                with their own conversation history and context awareness.
              </p>
            </div>

            {/* Two Column Layout */}
            <div className="grid lg:grid-cols-2 gap-12 items-start">
              {/* Left: Visual File Tree */}
              <div className="relative">
                <div className="rounded-xl border border-border bg-card p-6 shadow-lg">
                  <div className="flex items-center gap-2 mb-6 pb-4 border-b border-border">
                    <FolderTree className="h-5 w-5 text-primary" />
                    <span className="font-semibold">Workspace Structure</span>
                  </div>

                  {/* File Tree Visualization */}
                  <div className="space-y-1 font-mono text-sm">
                    {/* Global Assistant */}
                    <div className="flex items-center gap-2 p-2 rounded-md bg-gradient-to-r from-primary/20 to-primary/5 border border-primary/20">
                      <Globe className="h-4 w-4 text-primary flex-shrink-0" />
                      <span className="font-semibold text-primary">Global Assistant</span>
                      <span className="text-xs text-muted-foreground ml-auto">Your personal AI</span>
                    </div>

                    {/* Project 1 */}
                    <div className="ml-4 mt-3">
                      <div className="flex items-center gap-2 p-2">
                        <FolderTree className="h-4 w-4 text-muted-foreground" />
                        <span>Product Launch</span>
                      </div>
                      <div className="ml-4 space-y-1">
                        <div className="flex items-center gap-2 p-2 rounded-md bg-primary/10">
                          <Bot className="h-4 w-4 text-primary" />
                          <span className="text-primary">Marketing AI Agent</span>
                        </div>
                        <div className="flex items-center gap-2 p-2 text-muted-foreground">
                          <FileText className="h-4 w-4" />
                          <span>Launch Plan.doc</span>
                        </div>
                        <div className="flex items-center gap-2 p-2 text-muted-foreground">
                          <FileText className="h-4 w-4" />
                          <span>Press Release.doc</span>
                        </div>
                      </div>
                    </div>

                    {/* Project 2 */}
                    <div className="ml-4 mt-2">
                      <div className="flex items-center gap-2 p-2">
                        <FolderTree className="h-4 w-4 text-muted-foreground" />
                        <span>Engineering</span>
                      </div>
                      <div className="ml-4 space-y-1">
                        <div className="flex items-center gap-2 p-2 rounded-md bg-primary/10">
                          <Bot className="h-4 w-4 text-primary" />
                          <span className="text-primary">Code Review AI</span>
                        </div>
                        <div className="flex items-center gap-2 p-2 text-muted-foreground">
                          <FileText className="h-4 w-4" />
                          <span>Architecture.md</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Context Flow Indicator */}
                  <div className="mt-6 pt-4 border-t border-border">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <ChevronRight className="h-4 w-4" />
                      <span>Each agent sees its children &amp; inherits parent context</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Feature Cards */}
              <div className="space-y-6">
                {/* Global Assistant */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Globe className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Global Assistant</h3>
                      <p className="text-sm text-muted-foreground">
                        Your personal AI that follows you across all workspaces.
                        Perfect for quick questions, planning, and cross-project thinking.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Page Agents */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Bot className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Page Agents</h3>
                      <p className="text-sm text-muted-foreground">
                        AI agents that live in your file tree with their own conversation history.
                        Give each one a custom personality and system prompt.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Context Hierarchy */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Layers className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Nested Context</h3>
                      <p className="text-sm text-muted-foreground">
                        Agents automatically see their child pages. Project-level AI understands
                        the whole project while document-level AI focuses on specifics.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Multi-user */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Users className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Team AI</h3>
                      <p className="text-sm text-muted-foreground">
                        Multiple team members can chat with the same AI agent simultaneously.
                        The AI maintains context across all conversations.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ICP Example */}
            <div className="mt-16 mx-auto max-w-4xl">
              <div className="rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 p-6 md:p-8">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 flex-shrink-0">
                    <User className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-primary font-medium mb-2">How founders use this</p>
                    <p className="text-muted-foreground">
                      &ldquo;I use my Global Assistant for high-level planning and brainstorming.
                      For each project, I create specialized agents—one for marketing copy that knows our
                      brand voice, another for technical architecture that understands our stack.
                      They all work together, but each stays focused on what it knows best.&rdquo;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Footer - Minimal for now */}
        <footer className="border-t border-border py-8">
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                <span className="font-semibold">PageSpace</span>
              </div>
              <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
                <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
                <Link href="/downloads" className="hover:text-foreground transition-colors">Downloads</Link>
                <Link href="/docs" className="hover:text-foreground transition-colors">Docs</Link>
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
    </>
  );
}
