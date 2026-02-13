import Link from "next/link";
import { ArrowRight, Download, Sparkles, Users, Brain, FileText, MessageSquare, CheckSquare, Calendar, FolderTree, Bot, Globe, Layers, User, ChevronRight, Edit3, Type, Code, Undo2, Wand2, History, PenTool, AtSign, Hash, Reply, Lock, Send, Circle, CheckCircle2, Clock, BarChart3, ListTodo, UserPlus, CalendarDays, Video, Briefcase, Zap } from "lucide-react";
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

        {/* Documents Section */}
        <section className="border-t border-border bg-muted/30 py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-1.5 text-sm">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Documents</span>
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                Write with AI, your way
              </h2>
              <p className="text-lg text-muted-foreground">
                Rich text or markdown. AI suggestions inline or on demand.
                Full editing history with one-click rollback.
              </p>
            </div>

            {/* Two Column Layout */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              {/* Left: Document Editor Visual */}
              <div className="relative order-2 lg:order-1">
                <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                  {/* Editor Header */}
                  <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Building Your Personal Brand</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* Mode Toggle */}
                      <div className="flex items-center rounded-md border border-border bg-background p-0.5">
                        <div className="px-2 py-1 rounded bg-primary/10 text-primary text-xs font-medium">
                          <Type className="h-3 w-3 inline mr-1" />
                          Rich
                        </div>
                        <div className="px-2 py-1 text-xs text-muted-foreground">
                          <Code className="h-3 w-3 inline mr-1" />
                          Markdown
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Toolbar */}
                  <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-4 py-2">
                    <div className="flex items-center gap-1 pr-3 border-r border-border">
                      <button className="p-1.5 rounded hover:bg-muted text-muted-foreground">
                        <span className="text-xs font-bold">B</span>
                      </button>
                      <button className="p-1.5 rounded hover:bg-muted text-muted-foreground">
                        <span className="text-xs italic">I</span>
                      </button>
                      <button className="p-1.5 rounded hover:bg-muted text-muted-foreground">
                        <span className="text-xs underline">U</span>
                      </button>
                    </div>
                    <div className="flex items-center gap-1 px-3 border-r border-border">
                      <button className="p-1.5 rounded hover:bg-muted text-muted-foreground text-xs">H1</button>
                      <button className="p-1.5 rounded hover:bg-muted text-muted-foreground text-xs">H2</button>
                    </div>
                    <div className="flex items-center gap-1 ml-auto">
                      <button className="p-1.5 rounded hover:bg-muted text-muted-foreground">
                        <History className="h-3.5 w-3.5" />
                      </button>
                      <button className="p-1.5 rounded bg-primary/10 text-primary">
                        <Wand2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Editor Content */}
                  <div className="p-6 min-h-[320px]">
                    <h1 className="text-xl font-bold mb-4">Building Your Personal Brand in 2026</h1>
                    <p className="text-muted-foreground mb-4">
                      In the age of AI, your personal brand is more important than ever. Here&apos;s how to stand out...
                    </p>

                    {/* AI Suggestion Block */}
                    <div className="relative my-4">
                      <div className="absolute -left-3 top-0 bottom-0 w-1 rounded-full bg-primary" />
                      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <Sparkles className="h-4 w-4 text-primary" />
                          <span className="text-xs font-medium text-primary">AI Suggestion</span>
                          <div className="ml-auto flex items-center gap-1">
                            <button className="px-2 py-0.5 text-xs rounded border border-primary/30 text-primary hover:bg-primary/10">
                              Accept
                            </button>
                            <button className="px-2 py-0.5 text-xs rounded text-muted-foreground hover:bg-muted">
                              Dismiss
                            </button>
                          </div>
                        </div>
                        <p className="text-sm text-primary/80">
                          The key differentiator isn&apos;t just your skills—it&apos;s the unique perspective you bring.
                          AI can replicate knowledge, but it can&apos;t replicate your lived experience.
                        </p>
                      </div>
                    </div>

                    <p className="text-muted-foreground">
                      <span className="text-foreground">Authenticity is your superpower.</span> Share your failures alongside your wins...
                    </p>

                    {/* Cursor with AI suggestion appearing */}
                    <div className="mt-4 flex items-center gap-1">
                      <span className="h-5 w-0.5 bg-primary animate-pulse" />
                      <span className="text-xs text-muted-foreground italic opacity-60">
                        ...and your audience will connect on a deeper level.
                      </span>
                    </div>
                  </div>

                  {/* Editor Footer with AI Status */}
                  <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span>428 words</span>
                      <span className="text-border">•</span>
                      <span>Saved</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Undo2 className="h-3 w-3" />
                      <span>12 versions</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Feature Points */}
              <div className="space-y-6 order-1 lg:order-2">
                {/* AI Inline Editing */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Wand2 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">AI Inline Editing</h3>
                      <p className="text-sm text-muted-foreground">
                        AI suggestions appear right in your document. Accept, modify, or dismiss with a click.
                        No context switching to a chat window.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Rich Text / Markdown */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <PenTool className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Rich Text & Markdown</h3>
                      <p className="text-sm text-muted-foreground">
                        Toggle between visual editing and markdown with a click.
                        What you see is what you get, or go full keyboard-driven.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Version History */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Undo2 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">One-Click Rollback</h3>
                      <p className="text-sm text-muted-foreground">
                        Every AI edit is versioned. Don&apos;t like what AI suggested? Roll back to any previous
                        state instantly—no cherry-picking changes.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Multiple Doc Types */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Edit3 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Beyond Documents</h3>
                      <p className="text-sm text-muted-foreground">
                        Not just rich text—code blocks, spreadsheets, and custom canvases too.
                        Same AI-powered editing across all your content.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ICP Example - Content Creator */}
            <div className="mt-16 mx-auto max-w-4xl">
              <div className="rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 p-6 md:p-8">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 flex-shrink-0">
                    <User className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-primary font-medium mb-2">How content creators use this</p>
                    <p className="text-muted-foreground">
                      &ldquo;I write my blog posts in PageSpace now. The AI knows my voice from previous posts,
                      so suggestions actually sound like me. When I&apos;m stuck, I just highlight a paragraph
                      and ask for alternatives. And if I go too far down a rabbit hole? One click and
                      I&apos;m back to where I started. No more ctrl+Z 47 times.&rdquo;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Channels Section */}
        <section className="py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
                <MessageSquare className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Channels & DMs</span>
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                Team chat, upgraded with AI
              </h2>
              <p className="text-lg text-muted-foreground">
                @mention AI agents in any conversation. They respond in context,
                remembering past discussions and understanding your project.
              </p>
            </div>

            {/* Two Column Layout */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              {/* Left: Feature Points */}
              <div className="space-y-6">
                {/* @mention AI */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <AtSign className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">@mention AI Agents</h3>
                      <p className="text-sm text-muted-foreground">
                        Type @Marketing-AI or @Code-Review in any channel.
                        AI agents join the conversation with full context of the thread.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Channels */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Hash className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Public & Private Channels</h3>
                      <p className="text-sm text-muted-foreground">
                        Organize discussions by project, topic, or team.
                        AI agents can be added to specific channels for focused help.
                      </p>
                    </div>
                  </div>
                </div>

                {/* DMs */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Lock className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Private Conversations</h3>
                      <p className="text-sm text-muted-foreground">
                        Direct messages for 1:1 or small group conversations.
                        Add AI agents for private brainstorming sessions.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Threads */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Reply className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Threaded Discussions</h3>
                      <p className="text-sm text-muted-foreground">
                        Keep conversations organized with threads.
                        AI responds in the thread, keeping main channels clean.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Channel Chat Visual */}
              <div className="relative">
                <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                  {/* Channel Header */}
                  <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Hash className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">product-launch</span>
                      <span className="text-xs text-muted-foreground">12 members</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex -space-x-2">
                        <div className="h-6 w-6 rounded-full bg-blue-500 border-2 border-card flex items-center justify-center text-[10px] text-white font-medium">S</div>
                        <div className="h-6 w-6 rounded-full bg-green-500 border-2 border-card flex items-center justify-center text-[10px] text-white font-medium">M</div>
                        <div className="h-6 w-6 rounded-full bg-primary border-2 border-card flex items-center justify-center">
                          <Bot className="h-3 w-3 text-primary-foreground" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Chat Messages */}
                  <div className="p-4 space-y-4 min-h-[360px]">
                    {/* User message */}
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-blue-500 flex items-center justify-center text-xs text-white font-medium flex-shrink-0">S</div>
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium">Sarah</span>
                          <span className="text-xs text-muted-foreground">10:34 AM</span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          We need to finalize the launch email copy. <span className="text-primary font-medium">@Marketing-AI</span> can you draft something based on our positioning doc?
                        </p>
                      </div>
                    </div>

                    {/* AI response */}
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center flex-shrink-0">
                        <Bot className="h-4 w-4 text-primary-foreground" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-primary">Marketing AI</span>
                          <span className="text-xs text-muted-foreground">10:34 AM</span>
                          <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">AI</span>
                        </div>
                        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                          <p className="text-sm text-muted-foreground mb-2">
                            Based on your positioning doc, here&apos;s a draft:
                          </p>
                          <div className="bg-background rounded p-2 text-sm border border-border">
                            <p className="font-medium mb-1">Subject: Meet your new AI-powered workspace</p>
                            <p className="text-muted-foreground text-xs">
                              We&apos;re excited to introduce PageSpace—where your documents, tasks, and team conversations live alongside AI that actually understands your work...
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Another user reply */}
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-green-500 flex items-center justify-center text-xs text-white font-medium flex-shrink-0">M</div>
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium">Marcus</span>
                          <span className="text-xs text-muted-foreground">10:35 AM</span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Love it! Can we make the CTA more action-oriented?
                        </p>
                      </div>
                    </div>

                    {/* AI typing indicator */}
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center flex-shrink-0">
                        <Bot className="h-4 w-4 text-primary-foreground" />
                      </div>
                      <div className="flex items-center gap-2 py-2">
                        <div className="flex gap-1">
                          <div className="h-2 w-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="h-2 w-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="h-2 w-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                        <span className="text-xs text-muted-foreground">Marketing AI is typing...</span>
                      </div>
                    </div>
                  </div>

                  {/* Message Input */}
                  <div className="border-t border-border bg-muted/20 p-3">
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                      <AtSign className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground flex-1">Message #product-launch</span>
                      <Send className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ICP Example - Small Team */}
            <div className="mt-16 mx-auto max-w-4xl">
              <div className="rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 p-6 md:p-8">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 flex-shrink-0">
                    <Users className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-primary font-medium mb-2">How small teams use this</p>
                    <p className="text-muted-foreground">
                      &ldquo;We have specialized AI agents for different parts of our business—one knows our codebase,
                      one knows our marketing voice, one knows our customer conversations. When we&apos;re discussing
                      something cross-functional, we just @mention all of them. It&apos;s like having expert consultants
                      on call 24/7, but they actually know our specific context.&rdquo;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Tasks Section */}
        <section className="border-t border-border bg-muted/30 py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-1.5 text-sm">
                <CheckSquare className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Tasks</span>
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                Assign work to AI or humans
              </h2>
              <p className="text-lg text-muted-foreground">
                Create tasks and assign them to anyone—including AI agents.
                AI completes research, drafts, and analysis autonomously.
              </p>
            </div>

            {/* Two Column Layout */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              {/* Left: Task List Visual */}
              <div className="relative order-2 lg:order-1">
                <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                  {/* Task List Header */}
                  <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ListTodo className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Product Launch Tasks</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>4/7 complete</span>
                      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="w-[57%] h-full bg-primary rounded-full" />
                      </div>
                    </div>
                  </div>

                  {/* Task Items */}
                  <div className="divide-y divide-border">
                    {/* Completed task - human */}
                    <div className="flex items-center gap-3 px-4 py-3 bg-muted/10">
                      <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                      <span className="text-sm text-muted-foreground line-through flex-1">Finalize product positioning</span>
                      <div className="h-6 w-6 rounded-full bg-blue-500 flex items-center justify-center text-[10px] text-white font-medium">S</div>
                    </div>

                    {/* Completed task - AI */}
                    <div className="flex items-center gap-3 px-4 py-3 bg-muted/10">
                      <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                      <span className="text-sm text-muted-foreground line-through flex-1">Research competitor pricing</span>
                      <div className="h-6 w-6 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center">
                        <Bot className="h-3 w-3 text-primary-foreground" />
                      </div>
                    </div>

                    {/* In-progress task - AI */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="h-5 w-5 flex items-center justify-center flex-shrink-0">
                        <Clock className="h-4 w-4 text-primary animate-pulse" />
                      </div>
                      <div className="flex-1">
                        <span className="text-sm">Draft launch email sequence</span>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="h-1 flex-1 max-w-24 rounded-full bg-muted overflow-hidden">
                            <div className="w-[60%] h-full bg-primary rounded-full animate-pulse" />
                          </div>
                          <span className="text-[10px] text-primary">AI working...</span>
                        </div>
                      </div>
                      <div className="h-6 w-6 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center">
                        <Bot className="h-3 w-3 text-primary-foreground" />
                      </div>
                    </div>

                    {/* Pending task - human */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <Circle className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm flex-1">Review AI-generated drafts</span>
                      <div className="h-6 w-6 rounded-full bg-green-500 flex items-center justify-center text-[10px] text-white font-medium">M</div>
                    </div>

                    {/* Pending task - AI */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <Circle className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm flex-1">Generate social media graphics</span>
                      <div className="h-6 w-6 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center">
                        <Bot className="h-3 w-3 text-primary-foreground" />
                      </div>
                    </div>

                    {/* Pending task - unassigned */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <Circle className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm flex-1">Schedule launch webinar</span>
                      <div className="h-6 w-6 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
                        <UserPlus className="h-3 w-3 text-muted-foreground/50" />
                      </div>
                    </div>
                  </div>

                  {/* Rollup Footer */}
                  <div className="border-t border-border bg-muted/20 px-4 py-3">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex items-center gap-4">
                        <span className="flex items-center gap-1">
                          <div className="h-4 w-4 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center">
                            <Bot className="h-2 w-2 text-primary-foreground" />
                          </div>
                          3 AI tasks
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          2 human tasks
                        </span>
                      </div>
                      <span className="flex items-center gap-1">
                        <BarChart3 className="h-3 w-3" />
                        View rollup
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Feature Points */}
              <div className="space-y-6 order-1 lg:order-2">
                {/* AI Assignees */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Bot className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">AI as Assignee</h3>
                      <p className="text-sm text-muted-foreground">
                        Assign tasks directly to AI agents. They work autonomously—research,
                        draft, analyze—and notify you when done.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Task Lists as Pages */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <ListTodo className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Task Lists as Pages</h3>
                      <p className="text-sm text-muted-foreground">
                        Task lists are just another page type. Nest them in your file tree,
                        attach context, and AI agents automatically understand the scope.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Rollups */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <BarChart3 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Smart Rollups</h3>
                      <p className="text-sm text-muted-foreground">
                        See all tasks across drives, projects, or assigned to you.
                        Track what AI is working on vs. what needs human attention.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Mixed Teams */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Users className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Human + AI Teams</h3>
                      <p className="text-sm text-muted-foreground">
                        AI handles the research and first drafts. Humans review and refine.
                        A natural workflow where everyone does what they&apos;re best at.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ICP Example - Founder */}
            <div className="mt-16 mx-auto max-w-4xl">
              <div className="rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 p-6 md:p-8">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 flex-shrink-0">
                    <User className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-primary font-medium mb-2">How founders use this</p>
                    <p className="text-muted-foreground">
                      &ldquo;Monday morning I dump 20 research tasks into PageSpace and assign them all to my Research AI.
                      By afternoon, I have competitor analyses, market data, and draft summaries waiting for review.
                      My team handles the strategic decisions—AI handles the grunt work. We&apos;re a 5-person startup
                      that operates like a 20-person company.&rdquo;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Calendar Section */}
        <section className="py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
                <Calendar className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Calendar</span>
              </div>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                Everything in one view
              </h2>
              <p className="text-lg text-muted-foreground">
                Unified calendar across all your workspaces.
                Task deadlines, meetings, and AI work sessions—all in one place.
              </p>
            </div>

            {/* Two Column Layout */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              {/* Left: Feature Points */}
              <div className="space-y-6">
                {/* Unified View */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <CalendarDays className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Cross-Workspace View</h3>
                      <p className="text-sm text-muted-foreground">
                        See events from all your drives in one calendar.
                        Filter by workspace, project, or person when you need focus.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Google Calendar */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Zap className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Google Calendar Sync</h3>
                      <p className="text-sm text-muted-foreground">
                        Connect your Google Calendar to see everything together.
                        External meetings alongside PageSpace deadlines.
                      </p>
                    </div>
                  </div>
                </div>

                {/* AI Awareness */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Bot className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">AI Scheduling Awareness</h3>
                      <p className="text-sm text-muted-foreground">
                        AI agents see your calendar. They know when you&apos;re busy
                        and can suggest better times for focus work.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Task Deadlines */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <CheckSquare className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Task Deadlines</h3>
                      <p className="text-sm text-muted-foreground">
                        Task due dates appear on your calendar automatically.
                        Never miss a deadline because it was hidden in a task list.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Calendar Visual */}
              <div className="relative">
                <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                  {/* Calendar Header */}
                  <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <CalendarDays className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">February 2026</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="p-1 rounded hover:bg-muted text-muted-foreground">&larr;</button>
                      <button className="px-2 py-1 rounded bg-primary/10 text-primary text-xs">Today</button>
                      <button className="p-1 rounded hover:bg-muted text-muted-foreground">&rarr;</button>
                    </div>
                  </div>

                  {/* Calendar Grid - Week View */}
                  <div className="p-4">
                    {/* Day Headers */}
                    <div className="grid grid-cols-5 gap-2 mb-2 text-center">
                      <div className="text-xs text-muted-foreground">Mon 10</div>
                      <div className="text-xs text-muted-foreground">Tue 11</div>
                      <div className="text-xs font-medium text-primary">Wed 12</div>
                      <div className="text-xs text-muted-foreground">Thu 13</div>
                      <div className="text-xs text-muted-foreground">Fri 14</div>
                    </div>

                    {/* Time Slots */}
                    <div className="space-y-2">
                      {/* 9 AM */}
                      <div className="grid grid-cols-5 gap-2 items-start">
                        <div className="text-xs text-muted-foreground py-1">9:00</div>
                        <div className="col-span-4 grid grid-cols-4 gap-2">
                          <div className="rounded bg-blue-500/20 border border-blue-500/30 px-2 py-1 text-xs">
                            <div className="flex items-center gap-1">
                              <Video className="h-3 w-3 text-blue-500" />
                              <span className="truncate">Team standup</span>
                            </div>
                          </div>
                          <div />
                          <div className="rounded bg-blue-500/20 border border-blue-500/30 px-2 py-1 text-xs">
                            <div className="flex items-center gap-1">
                              <Video className="h-3 w-3 text-blue-500" />
                              <span className="truncate">1:1 with Sarah</span>
                            </div>
                          </div>
                          <div />
                        </div>
                      </div>

                      {/* 10 AM */}
                      <div className="grid grid-cols-5 gap-2 items-start">
                        <div className="text-xs text-muted-foreground py-1">10:00</div>
                        <div className="col-span-4 grid grid-cols-4 gap-2">
                          <div />
                          <div className="rounded bg-primary/20 border border-primary/30 px-2 py-1 text-xs col-span-2">
                            <div className="flex items-center gap-1">
                              <Bot className="h-3 w-3 text-primary" />
                              <span className="truncate">AI: Research deliverables</span>
                            </div>
                          </div>
                          <div />
                        </div>
                      </div>

                      {/* 11 AM */}
                      <div className="grid grid-cols-5 gap-2 items-start">
                        <div className="text-xs text-muted-foreground py-1">11:00</div>
                        <div className="col-span-4 grid grid-cols-4 gap-2">
                          <div className="rounded bg-green-500/20 border border-green-500/30 px-2 py-1 text-xs">
                            <div className="flex items-center gap-1">
                              <Briefcase className="h-3 w-3 text-green-500" />
                              <span className="truncate">Launch deadline</span>
                            </div>
                          </div>
                          <div />
                          <div />
                          <div className="rounded bg-orange-500/20 border border-orange-500/30 px-2 py-1 text-xs">
                            <div className="flex items-center gap-1">
                              <CheckSquare className="h-3 w-3 text-orange-500" />
                              <span className="truncate">Review drafts</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 2 PM */}
                      <div className="grid grid-cols-5 gap-2 items-start">
                        <div className="text-xs text-muted-foreground py-1">2:00</div>
                        <div className="col-span-4 grid grid-cols-4 gap-2">
                          <div />
                          <div className="rounded bg-purple-500/20 border border-purple-500/30 px-2 py-1 text-xs">
                            <div className="flex items-center gap-1 text-purple-500">
                              <Globe className="h-3 w-3" />
                              <span className="truncate">Investor call</span>
                            </div>
                          </div>
                          <div />
                          <div />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Legend */}
                  <div className="border-t border-border bg-muted/20 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <div className="h-2 w-2 rounded-full bg-blue-500" />
                        Meetings
                      </span>
                      <span className="flex items-center gap-1">
                        <div className="h-2 w-2 rounded-full bg-primary" />
                        AI Work
                      </span>
                      <span className="flex items-center gap-1">
                        <div className="h-2 w-2 rounded-full bg-orange-500" />
                        Tasks
                      </span>
                      <span className="flex items-center gap-1">
                        <div className="h-2 w-2 rounded-full bg-green-500" />
                        Deadlines
                      </span>
                      <span className="flex items-center gap-1">
                        <div className="h-2 w-2 rounded-full bg-purple-500" />
                        External
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ICP Example - Busy Founder */}
            <div className="mt-16 mx-auto max-w-4xl">
              <div className="rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 p-6 md:p-8">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 flex-shrink-0">
                    <User className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-primary font-medium mb-2">How busy founders use this</p>
                    <p className="text-muted-foreground">
                      &ldquo;I used to context-switch between 4 different calendars. Now I see everything in one place—
                      my investor calls from Google Calendar, task deadlines from all my projects, even the blocks
                      where AI is working on my behalf. When my Research AI schedules a &apos;deliverables ready&apos; event,
                      I know exactly when to expect results without constantly checking.&rdquo;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA Section */}
        <section className="border-t border-border bg-gradient-to-b from-muted/50 to-background py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            <div className="mx-auto max-w-4xl text-center">
              {/* Main CTA */}
              <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-primary">Start building your AI-powered workspace</span>
              </div>

              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-6">
                Ready to work differently?
              </h2>

              <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-10">
                Join teams who&apos;ve discovered that the best AI isn&apos;t a chatbot—it&apos;s a collaborator
                that lives in your workspace and understands your work.
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

              {/* Trust Signals */}
              <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground mb-12">
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Free tier available
                </span>
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  No credit card required
                </span>
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Cancel anytime
                </span>
              </div>

              {/* Quick Links */}
              <div className="flex flex-wrap items-center justify-center gap-6 pt-8 border-t border-border">
                <Link href="/downloads" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  <Download className="h-4 w-4" />
                  Desktop Apps
                </Link>
                <Link href="/docs" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  <FileText className="h-4 w-4" />
                  Documentation
                </Link>
                <Link href="/tour" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  <Layers className="h-4 w-4" />
                  Product Tour
                </Link>
                <Link href="/integrations" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  <Zap className="h-4 w-4" />
                  Integrations
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-border bg-muted/30 py-12 md:py-16">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
              {/* Product */}
              <div>
                <h3 className="font-semibold mb-4">Product</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><Link href="/tour" className="hover:text-foreground transition-colors">Product Tour</Link></li>
                  <li><Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link></li>
                  <li><Link href="/downloads" className="hover:text-foreground transition-colors">Downloads</Link></li>
                  <li><Link href="/integrations" className="hover:text-foreground transition-colors">Integrations</Link></li>
                  <li><Link href="/changelog" className="hover:text-foreground transition-colors">Changelog</Link></li>
                </ul>
              </div>

              {/* Resources */}
              <div>
                <h3 className="font-semibold mb-4">Resources</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><Link href="/docs" className="hover:text-foreground transition-colors">Documentation</Link></li>
                  <li><Link href="/blog" className="hover:text-foreground transition-colors">Blog</Link></li>
                  <li><Link href="/faq" className="hover:text-foreground transition-colors">FAQ</Link></li>
                  <li><Link href="/docs/api" className="hover:text-foreground transition-colors">API Reference</Link></li>
                </ul>
              </div>

              {/* Company */}
              <div>
                <h3 className="font-semibold mb-4">Company</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><Link href="/about" className="hover:text-foreground transition-colors">About</Link></li>
                  <li><Link href="/careers" className="hover:text-foreground transition-colors">Careers</Link></li>
                  <li><Link href="/contact" className="hover:text-foreground transition-colors">Contact</Link></li>
                </ul>
              </div>

              {/* Legal */}
              <div>
                <h3 className="font-semibold mb-4">Legal</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><Link href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link></li>
                  <li><Link href="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link></li>
                  <li><Link href="/security" className="hover:text-foreground transition-colors">Security</Link></li>
                </ul>
              </div>
            </div>

            {/* Bottom Bar */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 pt-8 border-t border-border">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                  <Sparkles className="h-5 w-5 text-primary-foreground" />
                </div>
                <span className="font-semibold">PageSpace</span>
              </div>
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
