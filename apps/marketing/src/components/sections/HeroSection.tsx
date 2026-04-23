import Link from "next/link";
import {
  ArrowRight,
  Download,
  PanelLeft,
  ChevronLeft,
  ChevronRight,
  Search,
  PanelRight,
  Home as HomeIcon,
  Folder,
  ChevronsUpDown,
  Inbox,
  CheckSquare,
  Calendar,
  Plus,
  FileText,
  MessageSquare,
  Share2,
  Settings2,
  FileDown,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Pilcrow,
  List,
  ListOrdered,
  Quote,
  Table2,
  ChevronDown,
  History,
  Activity,
  MoreHorizontal,
  Eye,
  Edit3,
  CheckCircle2,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_URL } from "@/lib/metadata";
import { JsonLd, webApplicationSchema } from "@/lib/schema";

export function HeroSection() {
  return (
    <>
      <JsonLd data={webApplicationSchema} />
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(59,130,246,0.15),rgba(255,255,255,0))]" />

        <div className="container mx-auto px-4 md:px-6 py-16 md:py-24 lg:py-32">
          <div className="mx-auto max-w-4xl text-center">
            <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
              Get on the{" "}
              <span className="bg-gradient-to-r from-primary to-primary/60 dark:from-[oklch(0.78_0.18_235)] dark:to-[oklch(0.55_0.16_235)] bg-clip-text text-transparent">
                same page
              </span>
            </h1>

            <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground md:text-xl">
              A unified workspace where AI agents live alongside your documents, tasks, and conversations.
              Not a chatbot—an intelligent collaborator that understands your entire workspace.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
              <Button size="lg" asChild className="w-full sm:w-auto">
                <a href={`${APP_URL}/auth/signup`}>
                  Get Started Free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
                <Link href="/pricing">View Pricing</Link>
              </Button>
            </div>

            <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
              <Link href="/downloads" className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors">
                <Download className="h-4 w-4" />
                <span>Mac, Windows, Linux</span>
              </Link>
              <span className="text-border">|</span>
              <Link href="/downloads" className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors">
                <span>iOS</span>
                <span className="text-xs bg-muted px-1.5 py-0.5 rounded">Beta</span>
              </Link>
            </div>
          </div>

          <AppPreview />
        </div>
      </section>
    </>
  );
}

function AppPreview() {
  return (
    <div className="mt-16 md:mt-24">
      <div className="mx-auto max-w-6xl">
        <div className="relative rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
          <TopBar />
          <div className="flex h-[400px] md:h-[500px] lg:h-[600px]">
            <SidebarPreview />
            <EditorPreview />
            <AIPanelPreview />
          </div>
        </div>
      </div>
    </div>
  );
}

function TopBar() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
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
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <HomeIcon className="h-3 w-3" />
        <span>/</span>
      </div>
      <div className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground w-48">
        <Search className="h-3 w-3" />
        <span className="flex-1">Search...</span>
        <kbd className="text-[10px] opacity-60">⌘K</kbd>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1">
        <button className="h-6 w-6 rounded-md flex items-center justify-center hover:bg-muted transition-colors">
          <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
          <span className="text-[8px] font-medium text-white">JD</span>
        </div>
      </div>
    </div>
  );
}

function SidebarPreview() {
  return (
    <div className="hidden sm:flex w-56 flex-col pt-4">
      <div className="flex-1 flex flex-col liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none px-3 py-3">
        <div className="mb-3">
          <button className="flex items-center gap-2 px-2 h-8 w-full rounded-lg hover:bg-accent transition-colors">
            <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="truncate font-medium text-xs flex-1 text-left">My Workspace</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </div>

        <nav className="flex flex-col gap-0.5 mb-2">
          {[
            { icon: HomeIcon, label: "Dashboard" },
            { icon: Inbox, label: "Inbox", badge: "3" },
            { icon: CheckSquare, label: "Tasks" },
            { icon: Calendar, label: "Calendar" },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium transition-colors cursor-pointer text-sidebar-foreground hover:bg-accent hover:text-accent-foreground">
              <item.icon className="h-3.5 w-3.5" />
              <span className="flex-1">{item.label}</span>
              {item.badge && <span className="px-2 py-0.5 text-[10px] rounded-full bg-primary text-primary-foreground">{item.badge}</span>}
            </div>
          ))}
        </nav>

        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <div className="h-7 w-full pl-8 pr-3 rounded-lg border border-border bg-background text-xs text-muted-foreground flex items-center">Search...</div>
          </div>
          <button className="h-7 w-7 shrink-0 rounded-lg border border-border bg-background flex items-center justify-center hover:bg-accent transition-colors">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>

        <nav className="flex-1 overflow-auto px-1 py-2">
          <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 bg-gray-200 dark:bg-gray-700" style={{ paddingLeft: 4 }}>
            <button className="p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors cursor-pointer">
              <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform duration-200 rotate-90" />
            </button>
            <div className="p-0.5 rounded cursor-grab">
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
            </div>
            <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">Q1 Planning</span>
          </div>

          {[
            { icon: FileText, label: "Product Roadmap", indent: 12, dot: true },
            { icon: MessageSquare, label: "Team Discussion", indent: 12 },
          ].map((item) => (
            <div key={item.label} className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700" style={{ paddingLeft: item.indent }}>
              <div className="p-0.5 rounded cursor-grab">
                <item.icon className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
              </div>
              {item.dot && <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 ml-1" />}
              <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">{item.label}</span>
            </div>
          ))}

          <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700 mt-1" style={{ paddingLeft: 4 }}>
            <button className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors cursor-pointer">
              <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform duration-200" />
            </button>
            <div className="p-0.5 rounded cursor-grab">
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
            </div>
            <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">Product Launch</span>
          </div>

          <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700" style={{ paddingLeft: 4 }}>
            <div className="p-0.5 rounded cursor-grab ml-6">
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
            </div>
            <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">Meeting Notes</span>
          </div>
        </nav>

        <div className="pt-2 border-t border-border">
          <button className="flex items-center justify-between w-full px-2 py-1 rounded-lg hover:bg-accent transition-colors">
            <span className="text-xs font-medium text-muted-foreground">Drive Actions</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}

function EditorPreview() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex flex-col gap-1 sm:gap-2 p-2 sm:p-4 border-b border-[var(--separator)]">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="hover:text-foreground cursor-pointer">My Workspace</span>
          <ChevronRight className="h-2.5 w-2.5" />
          <span className="text-foreground">Q1 Planning</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h2 className="text-sm sm:text-lg font-bold truncate">Q1 Planning</h2>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              <span>Saved</span>
            </div>
          </div>
          <div className="hidden sm:flex flex-wrap items-center justify-end gap-1 sm:gap-1.5">
            <button className="h-6 px-1.5 rounded-md hover:bg-muted text-muted-foreground flex items-center gap-1 text-[10px]">
              <Settings2 className="h-3.5 w-3.5" />
            </button>
            <button className="h-6 px-1.5 rounded-md hover:bg-muted text-muted-foreground flex items-center gap-1 text-[10px]">
              <FileDown className="h-3.5 w-3.5" />
            </button>
            <div className="flex -space-x-2">
              <div className="h-6 w-6 rounded-full bg-primary border-2 border-card flex items-center justify-center text-[9px] text-white font-medium">JD</div>
              <div className="h-6 w-6 rounded-full bg-emerald-500 border-2 border-card flex items-center justify-center text-[9px] text-white font-medium">SK</div>
            </div>
            <button className="h-6 px-2 rounded-md bg-primary text-primary-foreground text-[10px] font-medium flex items-center gap-1">
              <Share2 className="h-3 w-3" />
              Share
            </button>
          </div>
        </div>
      </div>

      <div className="mx-3 mt-3 rounded-md liquid-glass-thin border border-[var(--separator)] shadow-[var(--shadow-ambient)]">
        <div className="w-full overflow-x-auto">
          <div className="flex items-center gap-0.5 p-1.5 min-w-max">
            {[Bold, Italic, Strikethrough, Code].map((Icon, i) => (
              <button key={i} className="p-1.5 rounded transition-colors hover:bg-muted"><Icon size={13} /></button>
            ))}
            <div className="w-[1px] h-4 bg-border mx-0.5" />
            {[Heading1, Heading2, Heading3].map((Icon, i) => (
              <button key={i} className="p-1.5 rounded transition-colors hover:bg-muted"><Icon size={13} /></button>
            ))}
            <button className="p-1.5 rounded transition-colors bg-primary text-primary-foreground"><Pilcrow size={13} /></button>
            <div className="w-[1px] h-4 bg-border mx-0.5" />
            {[List, ListOrdered, Quote].map((Icon, i) => (
              <button key={i} className="p-1.5 rounded transition-colors hover:bg-muted"><Icon size={13} /></button>
            ))}
            <div className="w-[1px] h-4 bg-border mx-0.5" />
            <button className="p-1.5 rounded transition-colors hover:bg-muted"><Table2 size={13} /></button>
            <div className="flex-1" />
            <div className="w-[1px] h-4 bg-border mx-0.5" />
            <button className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-muted-foreground hover:bg-muted transition-colors">
              Sans <ChevronDown size={10} />
            </button>
            <button className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-muted-foreground hover:bg-muted transition-colors">
              16px <ChevronDown size={10} />
            </button>
          </div>
        </div>
      </div>

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
          <div className="flex justify-end px-5 pb-4 text-xs text-muted-foreground">847 characters</div>
        </div>
      </div>
    </div>
  );
}

function AIPanelPreview() {
  return (
    <div className="hidden lg:flex w-56 flex-col pt-4">
      <div className="flex-1 flex flex-col liquid-glass-regular rounded-tl-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none">
        <div className="flex items-center border-b border-border">
          {[
            { icon: MessageSquare, label: "Chat", active: true },
            { icon: History, label: "History" },
            { icon: Activity, label: "Activity" },
          ].map((tab) => (
            <button key={tab.label} className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium border-b-2 ${tab.active ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>
              <tab.icon className="h-3 w-3" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent text-xs font-medium transition-colors">
            Global Assistant
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
          <button className="h-6 w-6 rounded-md hover:bg-accent flex items-center justify-center transition-colors" title="New Conversation">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-2 flex flex-col gap-1.5">
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

          {[
            { icon: Eye, label: "Read Q1 Planning" },
            { icon: Edit3, label: "Edit Q1 Planning" },
          ].map((tool) => (
            <div key={tool.label} className="py-0.5 text-[11px]">
              <button className="w-full flex items-center gap-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <tool.icon className="h-3 w-3 text-muted-foreground" />
                <span className="font-medium truncate flex-1 min-w-0">{tool.label}</span>
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              </button>
            </div>
          ))}

          <div className="group relative">
            <p className="text-[10px] text-foreground">Done — I've added a Key Objectives section with the three priorities as bullet points.</p>
            <span className="text-[10px] text-muted-foreground/60">10:32 AM</span>
          </div>
        </div>

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
  );
}
