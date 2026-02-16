import Link from "next/link";
import { ArrowRight, ArrowUp, Download, Sparkles, Users, FileText, MessageSquare, CheckSquare, Calendar, FolderTree, Bot, Layers, User, ChevronRight, ChevronLeft, Edit3, Code, Undo2, Wand2, History, PenTool, AtSign, Hash, Paperclip, CheckCircle2, BarChart3, ListTodo, CalendarDays, Zap, Home as HomeIcon, Inbox, ChevronsUpDown, Folder, Search, Plus, ChevronDown, Wrench, Activity, MoreHorizontal, Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, Pilcrow, List, ListOrdered, Quote, Table2, Settings2, FileDown, Share2, PanelLeft, PanelRight, Eye, AlertCircle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";
import { JsonLd, webApplicationSchema } from "@/lib/schema";

export const metadata = pageMetadata.home;

export default function Home() {
  return (
    <>
      <JsonLd data={webApplicationSchema} />
      <div className="min-h-screen bg-background">
        {/* Navigation — matches prod TopBar */}
        <SiteNavbar />

        {/* Hero Section */}
        <section className="relative overflow-hidden">
          {/* Background gradient */}
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(59,130,246,0.15),rgba(255,255,255,0))]" />

          <div className="container mx-auto px-4 md:px-6 py-16 md:py-24 lg:py-32">
            <div className="mx-auto max-w-4xl text-center">
              {/* Headline */}
              <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
                Get on the{" "}
                <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                  same page
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
                  {/* TopBar — matches real desktop app TopBar */}
                  <div className="flex items-center gap-2 px-3 py-2 liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
                    {/* Left: sidebar toggle + nav */}
                    <div className="flex items-center gap-1">
                      <button className="h-6 w-6 rounded-md flex items-center justify-center hover:bg-muted transition-colors">
                        <PanelLeft className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                      <button className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground/40 cursor-not-allowed">
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <button className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground/40 cursor-not-allowed">
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* Breadcrumb */}
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <HomeIcon className="h-3 w-3" />
                      <span>/</span>
                    </div>
                    {/* Search */}
                    <div className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground w-48">
                      <Search className="h-3 w-3" />
                      <span className="flex-1">Search...</span>
                      <kbd className="text-[10px] opacity-60">⌘K</kbd>
                    </div>
                    <div className="flex-1" />
                    {/* Right: panel toggle + avatar */}
                    <div className="flex items-center gap-1">
                      <button className="h-6 w-6 rounded-md flex items-center justify-center hover:bg-muted transition-colors">
                        <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                      <div className="h-5 w-5 rounded-full bg-blue-500 flex items-center justify-center">
                        <span className="text-[8px] font-medium text-white">JD</span>
                      </div>
                    </div>
                  </div>

                  {/* App preview - EXACT MATCH to Layout.tsx structure */}
                  <div className="flex h-[400px] md:h-[500px] lg:h-[600px]">
                    {/* Sidebar - matching left-sidebar with pt-4 floating gap */}
                    <div className="hidden sm:flex w-56 flex-col pt-4">
                    <div className="flex-1 flex flex-col liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none px-3 py-3">
                      {/* 1. Drive Switcher - matches DriveSwitcher.tsx */}
                      <div className="mb-3">
                        <button className="flex items-center gap-2 px-2 h-8 w-full rounded-lg hover:bg-accent transition-colors">
                          <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
                          <span className="truncate font-medium text-xs flex-1 text-left">My Workspace</span>
                          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        </button>
                      </div>

                      {/* 2. Primary Navigation - matches PrimaryNavigation.tsx EXACTLY */}
                      <nav className="flex flex-col gap-0.5 mb-2">
                        <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium transition-colors cursor-pointer text-sidebar-foreground hover:bg-accent hover:text-accent-foreground">
                          <HomeIcon className="h-3.5 w-3.5" />
                          <span className="flex-1">Dashboard</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium transition-colors cursor-pointer text-sidebar-foreground hover:bg-accent hover:text-accent-foreground">
                          <Inbox className="h-3.5 w-3.5" />
                          <span className="flex-1">Inbox</span>
                          <span className="px-2 py-0.5 text-[10px] rounded-full bg-primary text-primary-foreground">3</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium transition-colors cursor-pointer text-sidebar-foreground hover:bg-accent hover:text-accent-foreground">
                          <CheckSquare className="h-3.5 w-3.5" />
                          <span className="flex-1">Tasks</span>
                        </div>
                        <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium transition-colors cursor-pointer text-sidebar-foreground hover:bg-accent hover:text-accent-foreground">
                          <Calendar className="h-3.5 w-3.5" />
                          <span className="flex-1">Calendar</span>
                        </div>
                      </nav>

                      {/* 3. Search + Create Button */}
                      <div className="flex items-center gap-2 mb-3">
                        <div className="relative flex-1">
                          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                          <div className="h-7 w-full pl-8 pr-3 rounded-lg border border-border bg-background text-xs text-muted-foreground flex items-center">
                            Search...
                          </div>
                        </div>
                        <button className="h-7 w-7 shrink-0 rounded-lg border border-border bg-background flex items-center justify-center hover:bg-accent transition-colors">
                          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </div>

                      {/* 4. Page Tree - ACTUAL PAGES only, no file extensions */}
                      <nav className="flex-1 overflow-auto px-1 py-2">
                        {/* Active page - Q1 Planning (expanded) */}
                        <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 bg-gray-200 dark:bg-gray-700" style={{ paddingLeft: 4 }}>
                          <button className="p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors cursor-pointer">
                            <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform duration-200 rotate-90" />
                          </button>
                          <div className="p-0.5 rounded cursor-grab">
                            <FileText className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                          </div>
                          <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">
                            Q1 Planning
                          </span>
                        </div>

                        {/* Child pages (indented) */}
                        <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700" style={{ paddingLeft: 12 }}>
                          <div className="p-0.5 rounded cursor-grab">
                            <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                          </div>
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0 ml-1" />
                          <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">
                            Product Roadmap
                          </span>
                        </div>

                        <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700" style={{ paddingLeft: 12 }}>
                          <div className="p-0.5 rounded cursor-grab">
                            <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                          </div>
                          <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">
                            Team Discussion
                          </span>
                        </div>

                        {/* Product Launch (collapsed) */}
                        <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700 mt-1" style={{ paddingLeft: 4 }}>
                          <button className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors cursor-pointer">
                            <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform duration-200" />
                          </button>
                          <div className="p-0.5 rounded cursor-grab">
                            <Folder className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                          </div>
                          <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">
                            Product Launch
                          </span>
                        </div>

                        {/* Meeting Notes (single page, no chevron) */}
                        <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700" style={{ paddingLeft: 4 }}>
                          <div className="p-0.5 rounded cursor-grab ml-6">
                            <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                          </div>
                          <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">
                            Meeting Notes
                          </span>
                        </div>
                      </nav>

                      {/* 5. Drive Actions (collapsed) - matches DriveFooter.tsx */}
                      <div className="pt-2 border-t border-border">
                        <button className="flex items-center justify-between w-full px-2 py-1 rounded-lg hover:bg-accent transition-colors">
                          <span className="text-xs font-medium text-muted-foreground">Drive Actions</span>
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </div>
                    </div>
                    </div>

                    {/* Main content — pixel-perfect editor replica */}
                    <div className="flex-1 flex flex-col overflow-hidden">
                      {/* Content Header — matches content-header/index.tsx */}
                      <div className="flex flex-col gap-1 sm:gap-2 p-2 sm:p-4 border-b border-[var(--separator)]">
                        {/* Breadcrumbs */}
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <span className="hover:text-foreground cursor-pointer">My Workspace</span>
                          <ChevronRight className="h-2.5 w-2.5" />
                          <span className="text-foreground">Q1 Planning</span>
                        </div>
                        {/* Title row */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <h2 className="text-sm sm:text-lg font-bold truncate">Q1 Planning</h2>
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                              <span>Saved</span>
                            </div>
                          </div>
                          <div className="hidden sm:flex flex-wrap items-center justify-end gap-1 sm:gap-1.5">
                            {/* Page Setup */}
                            <button className="h-6 px-1.5 rounded-md hover:bg-muted text-muted-foreground flex items-center gap-1 text-[10px]">
                              <Settings2 className="h-3.5 w-3.5" />
                            </button>
                            {/* Export */}
                            <button className="h-6 px-1.5 rounded-md hover:bg-muted text-muted-foreground flex items-center gap-1 text-[10px]">
                              <FileDown className="h-3.5 w-3.5" />
                            </button>
                            {/* Viewer avatars */}
                            <div className="flex -space-x-2">
                              <div className="h-6 w-6 rounded-full bg-blue-500 border-2 border-card flex items-center justify-center text-[9px] text-white font-medium">JD</div>
                              <div className="h-6 w-6 rounded-full bg-emerald-500 border-2 border-card flex items-center justify-center text-[9px] text-white font-medium">SK</div>
                            </div>
                            {/* Share */}
                            <button className="h-6 px-2 rounded-md bg-primary text-primary-foreground text-[10px] font-medium flex items-center gap-1">
                              <Share2 className="h-3 w-3" />
                              Share
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Toolbar — matches Toolbar.tsx (scaled down) */}
                      <div className="mx-3 mt-3 rounded-md liquid-glass-thin border border-[var(--separator)] shadow-[var(--shadow-ambient)]">
                        <div className="w-full overflow-x-auto">
                          <div className="flex items-center gap-0.5 p-1.5 min-w-max">
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Bold size={13} /></button>
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Italic size={13} /></button>
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Strikethrough size={13} /></button>
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Code size={13} /></button>
                            <div className="w-[1px] h-4 bg-border mx-0.5" />
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Heading1 size={13} /></button>
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Heading2 size={13} /></button>
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Heading3 size={13} /></button>
                            <button className="p-1.5 rounded transition-colors bg-primary text-primary-foreground"><Pilcrow size={13} /></button>
                            <div className="w-[1px] h-4 bg-border mx-0.5" />
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><List size={13} /></button>
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><ListOrdered size={13} /></button>
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Quote size={13} /></button>
                            <div className="w-[1px] h-4 bg-border mx-0.5" />
                            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Table2 size={13} /></button>
                            <div className="flex-1" />
                            <div className="w-[1px] h-4 bg-border mx-0.5" />
                            {/* Font Family */}
                            <button className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-muted-foreground hover:bg-muted transition-colors">
                              Sans
                              <ChevronDown size={10} />
                            </button>
                            {/* Font Size */}
                            <button className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-muted-foreground hover:bg-muted transition-colors">
                              16px
                              <ChevronDown size={10} />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Editor Content Area — matches RichEditor.tsx layout */}
                      <div className="flex-1 overflow-auto flex justify-center items-start p-4">
                        <div className="max-w-4xl mx-auto w-full">
                          <div className="tiptap m-5">
                            <h1>Q1 Planning</h1>
                            <p>This document outlines our strategic priorities, key objectives, and execution timeline for the first quarter. All team members should review and contribute their department-specific goals.</p>
                            <h2>Key Objectives</h2>
                            <ul>
                              <li>Launch the redesigned onboarding flow and measure activation rate improvements</li>
                              <li>Expand AI agent capabilities with multi-model support and tool integration</li>
                              <li>Achieve 95% uptime SLA and reduce p99 latency below 200ms</li>
                            </ul>
                            <h2>Timeline</h2>
                            <p>The quarter is divided into three two-week sprints, each with clear deliverables and review checkpoints. Sprint demos happen every other Friday.</p>
                            <blockquote>Focus is not about saying yes to the thing you have to focus on. It is about saying no to the hundred other good ideas.</blockquote>
                            <h3>Sprint 1: Foundation</h3>
                            <p>The first sprint focuses on infrastructure upgrades and establishing the baseline metrics we will track throughout the quarter.</p>
                            <pre><code>{`deploy:
  environment: production
  region: us-west-2
  replicas: 3
  health_check: /api/health`}</code></pre>
                            <p>Once the deployment pipeline is validated, we can begin rolling out feature flags for the new editor experience.</p>
                          </div>
                          <div className="flex justify-end px-5 pb-4 text-xs text-muted-foreground">
                            847 characters
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* AI Panel - matching right-sidebar structure with floating gap */}
                    <div className="hidden lg:flex w-56 flex-col pt-4">
                    <div className="flex-1 flex flex-col liquid-glass-regular rounded-tl-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none">
                      {/* Tab Bar */}
                      <div className="flex items-center border-b border-border">
                        <button className="flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium border-b-2 border-primary text-primary">
                          <MessageSquare className="h-3 w-3" />
                          Chat
                        </button>
                        <button className="flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium text-muted-foreground border-b-2 border-transparent">
                          <History className="h-3 w-3" />
                          History
                        </button>
                        <button className="flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium text-muted-foreground border-b-2 border-transparent">
                          <Activity className="h-3 w-3" />
                          Activity
                        </button>
                      </div>

                      {/* Chat Header - AISelector mock */}
                      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                        <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent text-xs font-medium transition-colors">
                          Global Assistant
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button className="h-6 w-6 rounded-md hover:bg-accent flex items-center justify-center transition-colors" title="New Conversation">
                          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </div>

                      {/* Messages - compact mode, no avatars */}
                      <div className="flex-1 overflow-auto p-2 flex flex-col gap-1.5">
                        {/* User message */}
                        <div className="group relative bg-primary/10 dark:bg-accent/20 p-2 rounded-md ml-2">
                          <span className="text-[10px] font-medium text-primary">You</span>
                          <p className="text-[10px] text-foreground">Add key objectives for Q1 — onboarding redesign, AI capabilities, and uptime targets</p>
                          <span className="text-[10px] text-muted-foreground/60">10:31 AM</span>
                          <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button className="h-5 w-5 rounded flex items-center justify-center hover:bg-accent">
                              <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </div>
                        </div>

                        {/* Tool call: Read */}
                        <div className="py-0.5 text-[11px]">
                          <button className="w-full flex items-center gap-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors">
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            <Eye className="h-3 w-3 text-muted-foreground" />
                            <span className="font-medium truncate flex-1 min-w-0">Read Q1 Planning</span>
                            <CheckCircle2 className="h-3 w-3 text-green-500" />
                          </button>
                        </div>

                        {/* Tool call: Edit */}
                        <div className="py-0.5 text-[11px]">
                          <button className="w-full flex items-center gap-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors">
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            <Edit3 className="h-3 w-3 text-muted-foreground" />
                            <span className="font-medium truncate flex-1 min-w-0">Edit Q1 Planning</span>
                            <CheckCircle2 className="h-3 w-3 text-green-500" />
                          </button>
                        </div>

                        {/* AI response */}
                        <div className="group relative">
                          <p className="text-[10px] text-foreground">Done — I&apos;ve added a Key Objectives section with the three priorities as bullet points.</p>
                          <span className="text-[10px] text-muted-foreground/60">10:32 AM</span>
                          <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button className="h-5 w-5 rounded flex items-center justify-center hover:bg-accent">
                              <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Input area */}
                      <div className="p-2 border-t border-border">
                        <div className="rounded-lg border border-border bg-background">
                          <div className="px-3 py-2">
                            <span className="text-[10px] text-muted-foreground">Ask about this page...</span>
                          </div>
                          <div className="flex items-center justify-between px-2 pb-2">
                            <button className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent transition-colors">
                              <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground">Claude / Opus 4.6</span>
                              <button className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                                <ArrowRight className="h-3 w-3 text-primary-foreground" />
                              </button>
                            </div>
                          </div>
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

        {/* Page Tree Section */}
        <section className="py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                Everything is a page
              </h2>
              <p className="text-lg text-muted-foreground">
                Documents, channels, AI agents, spreadsheets, task lists, code files—all
                the same primitive in one tree. Where you place them shapes what AI knows about them.
              </p>
            </div>

            {/* Two Column Layout */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              {/* Left: Sidebar Mock */}
              <div className="relative">
                <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                  {/* Sidebar inner container */}
                  <div className="px-3 py-3 space-y-3">
                    {/* Drive Switcher */}
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <ChevronsUpDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="font-semibold text-sm">Acme Corp</span>
                    </div>

                    {/* Primary Navigation */}
                    <nav className="space-y-0.5">
                      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                        <HomeIcon className="h-4 w-4" />
                        <span>Dashboard</span>
                      </div>
                      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                        <Inbox className="h-4 w-4" />
                        <span>Inbox</span>
                      </div>
                      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                        <CheckSquare className="h-4 w-4" />
                        <span>Tasks</span>
                      </div>
                      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                        <Calendar className="h-4 w-4" />
                        <span>Calendar</span>
                      </div>
                    </nav>

                    {/* Search + Create */}
                    <div className="flex items-center gap-1.5">
                      <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <div className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm text-muted-foreground flex items-center">
                          Search pages...
                        </div>
                      </div>
                      <div className="flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background text-muted-foreground flex-shrink-0">
                        <Plus className="h-4 w-4" />
                      </div>
                    </div>

                    {/* Page Tree */}
                    <div className="space-y-0.5 text-sm">
                      {/* Expanded Folder: Product Launch */}
                      <div className="flex items-center gap-1 rounded-lg px-1 py-1.5 font-medium">
                        <ChevronRight className="h-4 w-4 text-gray-500 rotate-90 flex-shrink-0" />
                        <Folder className="h-4 w-4 text-primary flex-shrink-0" />
                        <span className="text-gray-900 dark:text-gray-100 truncate">Product Launch</span>
                      </div>
                      {/* Children — indented */}
                      <div className="space-y-0.5" style={{ paddingLeft: '16px' }}>
                        <div className="flex items-center gap-1 rounded-lg px-1 py-1.5 bg-gray-100 dark:bg-gray-800">
                          <span className="w-4 flex-shrink-0" />
                          <Sparkles className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="text-gray-900 dark:text-gray-100 font-medium truncate">Marketing Agent</span>
                        </div>
                        <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                          <span className="w-4 flex-shrink-0" />
                          <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="text-gray-900 dark:text-gray-100 font-medium truncate">Launch Plan</span>
                        </div>
                        <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                          <span className="w-4 flex-shrink-0" />
                          <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="text-gray-900 dark:text-gray-100 font-medium truncate">Press Kit</span>
                        </div>
                        {/* Channel with children — shows any page type can nest */}
                        <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                          <ChevronRight className="h-4 w-4 text-gray-500 rotate-90 flex-shrink-0" />
                          <MessageSquare className="h-4 w-4 text-primary flex-shrink-0" />
                          <span className="text-gray-900 dark:text-gray-100 font-medium truncate">team-updates</span>
                        </div>
                        <div className="space-y-0.5" style={{ paddingLeft: '20px' }}>
                          <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                            <span className="w-4 flex-shrink-0" />
                            <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="text-gray-900 dark:text-gray-100 font-medium truncate">standup-notes</span>
                          </div>
                          <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                            <span className="w-4 flex-shrink-0" />
                            <CheckSquare className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="text-gray-900 dark:text-gray-100 font-medium truncate">Q1 Action Items</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                          <span className="w-4 flex-shrink-0" />
                          <CheckSquare className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="text-gray-900 dark:text-gray-100 font-medium truncate">Launch Tasks</span>
                        </div>
                      </div>

                      {/* Collapsed Folder: Engineering */}
                      <div className="flex items-center gap-1 rounded-lg px-1 py-1.5 font-medium mt-0.5">
                        <ChevronRight className="h-4 w-4 text-gray-500 flex-shrink-0" />
                        <Folder className="h-4 w-4 text-primary flex-shrink-0" />
                        <span className="text-gray-900 dark:text-gray-100 truncate">Engineering</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Feature Cards */}
              <div className="space-y-6">
                {/* Everything is a Page */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Layers className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Everything is a Page</h3>
                      <p className="text-sm text-muted-foreground">
                        Documents, channels, AI agents, spreadsheets, task lists, code files—all
                        the same primitive. Nest and organize them however makes sense for your team.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Context is Structure */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <FolderTree className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Context is Structure</h3>
                      <p className="text-sm text-muted-foreground">
                        Where you place an AI agent determines what it knows. Put it next to a spec
                        and a channel—it sees both. Move it to a different project—different context.
                        The tree is the knowledge graph.
                      </p>
                    </div>
                  </div>
                </div>

                {/* AI at Every Level */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Sparkles className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">AI at Every Level</h3>
                      <p className="text-sm text-muted-foreground">
                        Drop an AI agent anywhere in the tree. A project-level agent understands
                        the whole project. A document-level agent focuses deeply. A global assistant
                        spans everything.
                      </p>
                    </div>
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
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
                Write with AI, your way
              </h2>
              <p className="text-lg text-muted-foreground">
                Rich text editing with a full formatting toolbar.
                AI edits your documents through the sidebar chat.
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
                    <div className="flex items-center gap-1" />
                  </div>

                  {/* Toolbar — matches real Toolbar.tsx + DocumentView.tsx wrapper */}
                  <div className="mx-4 mt-4 rounded-lg liquid-glass-thin border border-[var(--separator)] shadow-[var(--shadow-ambient)] overflow-hidden">
                    <div className="w-full overflow-x-auto">
                      <div className="flex items-center gap-1 p-2 min-w-max">
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Bold size={16} /></button>
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Italic size={16} /></button>
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Strikethrough size={16} /></button>
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Code size={16} /></button>
                        <div className="w-[1px] h-6 bg-border mx-1" />
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Heading1 size={16} /></button>
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Heading2 size={16} /></button>
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Heading3 size={16} /></button>
                        <button className="p-2 rounded-md transition-colors bg-primary text-primary-foreground"><Pilcrow size={16} /></button>
                        <div className="w-[1px] h-6 bg-border mx-1" />
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><List size={16} /></button>
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><ListOrdered size={16} /></button>
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Quote size={16} /></button>
                        <div className="w-[1px] h-6 bg-border mx-1" />
                        <button className="p-2 rounded-md transition-colors hover:bg-muted"><Table2 size={16} /></button>
                        <div className="ml-auto" />
                        <div className="w-[1px] h-6 bg-border mx-1" />
                        <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted transition-colors">
                          Sans <ChevronDown size={10} />
                        </button>
                        <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted transition-colors">
                          16px <ChevronDown size={10} />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Editor Content */}
                  <div className="p-6 min-h-[320px]">
                    <h1 className="text-xl font-bold mb-4">Building Your Personal Brand in 2026</h1>
                    <p className="text-muted-foreground mb-4">
                      In the age of AI, your personal brand is more important than ever. Here&apos;s how to stand out...
                    </p>

                    <p className="text-muted-foreground mb-4">
                      The key differentiator isn&apos;t just your skills—it&apos;s the unique perspective you bring.
                      AI can replicate knowledge, but it can&apos;t replicate your lived experience.
                    </p>

                    <p className="text-muted-foreground">
                      <span className="text-foreground">Authenticity is your superpower.</span> Share your failures alongside your wins,
                      and your audience will connect on a deeper level.
                    </p>
                  </div>

                </div>
              </div>

              {/* Right: Feature Points */}
              <div className="space-y-6 order-1 lg:order-2">
                {/* AI Chat Editing */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Wand2 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">AI-Powered Editing</h3>
                      <p className="text-sm text-muted-foreground">
                        Talk to AI in the sidebar chat and it edits your document directly.
                        Ask for rewrites, expansions, or tone changes without leaving your page.
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
          </div>
        </section>

        {/* Channels Section */}
        <section className="py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
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
                        AI agents join the conversation with full context of the channel.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Channels & DMs */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Hash className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Channels & Direct Messages</h3>
                      <p className="text-sm text-muted-foreground">
                        Public channels for team discussions, private channels for
                        focused work, and 1:1 DMs — all with AI agents available.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Inbox */}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                      <Inbox className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">Unified Inbox</h3>
                      <p className="text-sm text-muted-foreground">
                        Every channel, DM, and mention in one place.
                        Never lose track of a conversation across your workspace.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Channel Chat Visual - EXACT MATCH to ChannelView.tsx */}
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
                        <div className="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-violet-600 border-2 border-card flex items-center justify-center">
                          <Bot className="h-3 w-3 text-white" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Chat Messages - matching ChannelView.tsx structure */}
                  <div className="p-4 space-y-4 min-h-[360px] max-w-4xl mx-auto">
                    {/* User message - matching group flex items-start gap-4 */}
                    <div className="group flex items-start gap-4">
                      <div className="shrink-0 h-10 w-10 rounded-full bg-blue-500 flex items-center justify-center text-sm text-white font-medium">S</div>
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">Sarah</span>
                          <span className="text-xs text-muted-foreground">10:34 AM</span>
                        </div>
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <p className="text-sm">
                            We need to finalize the launch email copy. <span className="text-primary font-medium">@Marketing-AI</span> can you draft something based on our positioning doc?
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* AI response - matching aiLabel badge styling */}
                    <div className="group flex items-start gap-4">
                      <div className="shrink-0 h-10 w-10 rounded-full bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center">
                        <Bot className="h-5 w-5 text-white" />
                      </div>
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">Marketing AI</span>
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 font-medium">agent</span>
                          <span className="text-xs text-muted-foreground">10:34 AM</span>
                        </div>
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <p className="text-sm mb-2">Based on your positioning doc, here&apos;s a draft:</p>
                          <div className="bg-muted/50 rounded-lg p-3 text-sm border border-border/50">
                            <p className="font-medium mb-1">Subject: Meet your new AI-powered workspace</p>
                            <p className="text-muted-foreground text-sm">
                              We&apos;re excited to introduce PageSpace—where your documents, tasks, and team conversations live alongside AI that actually understands your work...
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Another user reply */}
                    <div className="group flex items-start gap-4">
                      <div className="shrink-0 h-10 w-10 rounded-full bg-green-500 flex items-center justify-center text-sm text-white font-medium">M</div>
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">Marcus</span>
                          <span className="text-xs text-muted-foreground">10:35 AM</span>
                        </div>
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <p className="text-sm">Love it! Can we make the CTA more action-oriented?</p>
                        </div>
                      </div>
                    </div>

                    {/* AI typing indicator */}
                    <div className="group flex items-start gap-4">
                      <div className="shrink-0 h-10 w-10 rounded-full bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center">
                        <Bot className="h-5 w-5 text-white" />
                      </div>
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">Marketing AI</span>
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 font-medium">agent</span>
                        </div>
                        <div className="flex items-center gap-2 py-1">
                          <div className="flex gap-1">
                            <div className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <div className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Message Input — matches InputCard + ChannelInput + ChannelInputFooter */}
                  <div className="p-4">
                    <div className="max-w-4xl mx-auto">
                      <div className="bg-background rounded-2xl border border-border/60 shadow-sm overflow-hidden">
                        {/* Input row */}
                        <div className="flex items-end gap-2 p-3">
                          <div className="flex-1 min-h-[36px] flex items-center">
                            <span className="text-sm text-muted-foreground">Message #product-launch...</span>
                          </div>
                          <button className="h-9 w-9 shrink-0 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
                            <ArrowUp className="h-4 w-4" />
                          </button>
                        </div>
                        {/* Footer — matches ChannelInputFooter.tsx */}
                        <div className="flex items-center justify-between px-3 py-2 border-t border-border/40">
                          <div className="flex items-center gap-0.5">
                            <button className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:bg-muted/50 flex items-center justify-center">
                              <Bold className="h-4 w-4" />
                            </button>
                            <div className="w-px h-4 bg-border/60 mx-1" />
                            <button className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:bg-muted/50 flex items-center justify-center">
                              <AtSign className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="flex items-center gap-1">
                            <button className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:bg-muted/50 flex items-center justify-center">
                              <Paperclip className="h-4 w-4" />
                            </button>
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

        {/* Tasks Section */}
        <section className="border-t border-border bg-muted/30 py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
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
              {/* Left: Task List Visual - EXACT MATCH to TaskCompactRow.tsx */}
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

                  {/* Task Items - Matching TaskCompactRow.tsx exactly */}
                  <div>
                    {/* Completed task - human */}
                    <div className="flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0 opacity-50">
                      <div className="shrink-0">
                        <Checkbox checked={true} className="h-5 w-5" />
                      </div>
                      <button type="button" className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0">
                        <span className="text-sm leading-snug line-through text-muted-foreground">Finalize product positioning</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-red-500" />
                          <span>Feb 8</span>
                          <span className="truncate max-w-[100px]">Sarah</span>
                        </div>
                      </button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                    </div>

                    {/* Completed task - AI */}
                    <div className="flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0 opacity-50">
                      <div className="shrink-0">
                        <Checkbox checked={true} className="h-5 w-5" />
                      </div>
                      <button type="button" className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0">
                        <span className="text-sm leading-snug line-through text-muted-foreground">Research competitor pricing</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-amber-500" />
                          <span>Feb 7</span>
                          <span className="truncate max-w-[100px]">Research AI</span>
                        </div>
                      </button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                    </div>

                    {/* In-progress task - AI */}
                    <div className="flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0">
                      <div className="shrink-0">
                        <Checkbox checked={false} className="h-5 w-5" />
                      </div>
                      <button type="button" className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0">
                        <span className="text-sm leading-snug text-foreground">Draft launch email sequence</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-red-500" />
                          <span className="text-amber-600 dark:text-amber-400 font-medium">Today</span>
                          <span className="truncate max-w-[100px]">Marketing AI</span>
                          <span className="truncate max-w-[80px] text-muted-foreground/70">Launch Tasks</span>
                        </div>
                      </button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                    </div>

                    {/* Pending task - human */}
                    <div className="flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0">
                      <div className="shrink-0">
                        <Checkbox checked={false} className="h-5 w-5" />
                      </div>
                      <button type="button" className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0">
                        <span className="text-sm leading-snug text-foreground">Review AI-generated drafts</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-amber-500" />
                          <span>Feb 14</span>
                          <span className="truncate max-w-[100px]">Marcus</span>
                        </div>
                      </button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                    </div>

                    {/* Pending task - AI */}
                    <div className="flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0">
                      <div className="shrink-0">
                        <Checkbox checked={false} className="h-5 w-5" />
                      </div>
                      <button type="button" className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0">
                        <span className="text-sm leading-snug text-foreground">Generate social media graphics</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-slate-400 dark:bg-slate-500" />
                          <span>Feb 15</span>
                          <span className="truncate max-w-[100px]">Design AI</span>
                        </div>
                      </button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                    </div>

                    {/* Pending task - overdue */}
                    <div className="flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0">
                      <div className="shrink-0">
                        <Checkbox checked={false} className="h-5 w-5" />
                      </div>
                      <button type="button" className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0">
                        <span className="text-sm leading-snug text-foreground">Schedule launch webinar</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-red-500" />
                          <span className="flex items-center gap-0.5 text-red-500 font-medium">
                            <AlertCircle className="h-3 w-3" />
                            Feb 10
                          </span>
                        </div>
                      </button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
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
          </div>
        </section>

        {/* Calendar Section */}
        <section className="py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            {/* Section Header */}
            <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
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

              {/* Right: Calendar Visual - EXACT MATCH to WeekView.tsx */}
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

                  {/* Week View - matching WeekView.tsx structure */}
                  <div className="flex flex-col h-[320px] overflow-hidden">
                    {/* Header with day names */}
                    <div className="flex border-b bg-background sticky top-0 z-10">
                      {/* Time gutter spacer */}
                      <div className="w-16 shrink-0 border-r" />
                      {/* Day columns header */}
                      {[
                        { day: 'Mon', date: 10, isToday: false },
                        { day: 'Tue', date: 11, isToday: false },
                        { day: 'Wed', date: 12, isToday: true },
                        { day: 'Thu', date: 13, isToday: false },
                        { day: 'Fri', date: 14, isToday: false },
                      ].map((d) => (
                        <div key={d.day} className="flex-1 border-r last:border-r-0">
                          <button className={`w-full px-2 py-2 text-center hover:bg-muted/50 transition-colors ${d.isToday ? 'bg-primary/5' : ''}`}>
                            <div className="text-xs text-muted-foreground">{d.day}</div>
                            <div className={`text-lg font-semibold w-8 h-8 mx-auto flex items-center justify-center rounded-full ${d.isToday ? 'bg-primary text-primary-foreground' : ''}`}>
                              {d.date}
                            </div>
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* Time grid */}
                    <div className="flex-1 overflow-auto">
                      <div className="flex min-h-full">
                        {/* Time gutter */}
                        <div className="w-16 shrink-0 border-r">
                          {[9, 10, 11, 12, 14].map((hour) => (
                            <div key={hour} className="relative border-b" style={{ height: 48 }}>
                              <span className="absolute -top-2.5 right-2 text-xs text-muted-foreground">
                                {hour > 12 ? `${hour - 12} PM` : hour === 12 ? '12 PM' : `${hour} AM`}
                              </span>
                            </div>
                          ))}
                        </div>

                        {/* Day columns with events */}
                        <div className="flex-1 flex">
                          {/* Monday */}
                          <div className="flex-1 border-r relative">
                            {[9, 10, 11, 12, 14].map((h) => (
                              <div key={h} className="border-b hover:bg-muted/30 cursor-pointer transition-colors" style={{ height: 48 }} />
                            ))}
                            {/* Event: Team standup */}
                            <button className="absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs overflow-hidden border-l-2 bg-purple-500/10 border-l-purple-500 hover:opacity-80 transition-opacity cursor-pointer text-left" style={{ top: 0, height: 40 }}>
                              <div className="font-medium truncate text-purple-600">Team standup</div>
                              <div className="text-muted-foreground truncate">9:00 AM</div>
                            </button>
                          </div>

                          {/* Tuesday */}
                          <div className="flex-1 border-r relative">
                            {[9, 10, 11, 12, 14].map((h) => (
                              <div key={h} className="border-b hover:bg-muted/30 cursor-pointer transition-colors" style={{ height: 48 }} />
                            ))}
                            {/* Event: AI Research */}
                            <button className="absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs overflow-hidden border-l-2 bg-slate-500/10 border-l-slate-500 hover:opacity-80 transition-opacity cursor-pointer text-left" style={{ top: 48, height: 80 }}>
                              <div className="font-medium truncate text-slate-600">AI: Research</div>
                              <div className="text-muted-foreground truncate">10:00 AM</div>
                            </button>
                          </div>

                          {/* Wednesday (Today) */}
                          <div className="flex-1 border-r relative">
                            {[9, 10, 11, 12, 14].map((h) => (
                              <div key={h} className="border-b hover:bg-muted/30 cursor-pointer transition-colors" style={{ height: 48 }} />
                            ))}
                            {/* Current time indicator */}
                            <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: 72 }}>
                              <div className="flex items-center">
                                <div className="w-2 h-2 rounded-full bg-red-500" />
                                <div className="flex-1 h-0.5 bg-red-500" />
                              </div>
                            </div>
                            {/* Event: 1:1 with Sarah */}
                            <button className="absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs overflow-hidden border-l-2 bg-purple-500/10 border-l-purple-500 hover:opacity-80 transition-opacity cursor-pointer text-left" style={{ top: 0, height: 40 }}>
                              <div className="font-medium truncate text-purple-600">1:1 with Sarah</div>
                              <div className="text-muted-foreground truncate">9:00 AM</div>
                            </button>
                          </div>

                          {/* Thursday */}
                          <div className="flex-1 border-r relative">
                            {[9, 10, 11, 12, 14].map((h) => (
                              <div key={h} className="border-b hover:bg-muted/30 cursor-pointer transition-colors" style={{ height: 48 }} />
                            ))}
                            {/* Event: Launch deadline */}
                            <button className="absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs overflow-hidden border-l-2 bg-red-500/10 border-l-red-500 hover:opacity-80 transition-opacity cursor-pointer text-left" style={{ top: 96, height: 40 }}>
                              <div className="font-medium truncate text-red-600">Launch deadline</div>
                              <div className="text-muted-foreground truncate">11:00 AM</div>
                            </button>
                            {/* Event: Investor call */}
                            <button className="absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs overflow-hidden border-l-2 bg-purple-500/10 border-l-purple-500 hover:opacity-80 transition-opacity cursor-pointer text-left" style={{ top: 192, height: 48 }}>
                              <div className="font-medium truncate text-purple-600">Investor call</div>
                              <div className="text-muted-foreground truncate">2:00 PM</div>
                            </button>
                          </div>

                          {/* Friday */}
                          <div className="flex-1 relative">
                            {[9, 10, 11, 12, 14].map((h) => (
                              <div key={h} className="border-b hover:bg-muted/30 cursor-pointer transition-colors" style={{ height: 48 }} />
                            ))}
                            {/* Task overlay: Review drafts */}
                            <button className="absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs truncate border-l-2 bg-muted/30 border-l-muted-foreground/50 border-dashed opacity-70 hover:opacity-100 transition-opacity" style={{ top: 96, height: 32 }}>
                              <span className="mr-1">☐</span>
                              <span className="text-muted-foreground italic">Review drafts</span>
                            </button>
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

        {/* Final CTA Section */}
        <section className="border-t border-border bg-gradient-to-b from-muted/50 to-background py-16 md:py-24 lg:py-32">
          <div className="container mx-auto px-4 md:px-6">
            <div className="mx-auto max-w-4xl text-center">
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

        <SiteFooter />
      </div>
    </>
  );
}
