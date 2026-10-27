import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CheckSquare,
  Calendar,
  ChevronRight,
  ChevronLeft,
  Folder,
  FileText,
  MessageSquare,
  Plus,
  CheckCircle2,
  Circle,
  Sparkles,
  Shield,
  ListTodo,
  Brain,
  Users,
  ChevronDown,
  Edit3,
  Eye,
  Heart,
  Leaf,
  PanelLeft,
  PanelRight,
  Search,
  Home as HomeIcon,
  ChevronsUpDown,
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
  History,
  Activity,
  MoreHorizontal,
  Wrench,
  Share2,
  Settings2,
  FileDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_URL } from "@/lib/metadata";

// ─── Hero ────────────────────────────────────────────────────────────────────

export function HomeschoolHeroSection() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(59,130,246,0.15),rgba(255,255,255,0))]" />

      <div className="container mx-auto px-4 md:px-6 py-16 md:py-24 lg:py-32">
        <div className="mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary mb-6">
            <Heart className="h-4 w-4" />
            <span>For families who teach at home</span>
          </div>

          <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
            One calm workspace{" "}
            <span className="bg-gradient-to-r from-primary to-primary/60 dark:from-[oklch(0.78_0.18_235)] dark:to-[oklch(0.55_0.16_235)] bg-clip-text text-transparent">
              for your whole homeschool
            </span>
          </h1>

          <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground md:text-xl">
            Plan your weeks, see what each child covered, and ask AI for help finding resources —
            without juggling six apps or feeling behind on your planner.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
            <Button size="lg" asChild className="w-full sm:w-auto">
              <a href={`${APP_URL}/auth/signup`}>
                Start free — no card required
                <ArrowRight className="ml-2 h-4 w-4" />
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            Free to start. Unlimited pages, AI chat, and task lists. No credit card needed.
          </p>
        </div>

        <HomeschoolAppPreview />
      </div>
    </section>
  );
}

function HomeschoolAppPreview() {
  return (
    <div className="mt-16 md:mt-24">
      <div className="mx-auto max-w-6xl">
        <div className="relative rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
          <HSTopBar />
          <div className="flex h-[400px] md:h-[500px] lg:h-[600px]">
            <HSSidebarPreview />
            <HSEditorPreview />
            <HSAIPanelPreview />
          </div>
        </div>
      </div>
    </div>
  );
}

function HSTopBar() {
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
          <span className="text-[8px] font-medium text-white">MJ</span>
        </div>
      </div>
    </div>
  );
}

function HSSidebarPreview() {
  return (
    <div className="hidden sm:flex w-56 flex-col pt-4">
      <div className="flex-1 flex flex-col liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none px-3 py-3">
        <div className="mb-3">
          <button className="flex items-center gap-2 px-2 h-8 w-full rounded-lg hover:bg-accent transition-colors">
            <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="truncate font-medium text-xs flex-1 text-left">Our Homeschool</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </div>

        <nav className="flex flex-col gap-0.5 mb-2">
          {[
            { icon: HomeIcon, label: "Dashboard" },
            { icon: CheckSquare, label: "Tasks" },
            { icon: Calendar, label: "Calendar" },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium transition-colors cursor-pointer text-sidebar-foreground hover:bg-accent hover:text-accent-foreground">
              <item.icon className="h-3.5 w-3.5" />
              <span className="flex-1">{item.label}</span>
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
          {/* Morning Basket — expanded folder, active */}
          <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 bg-gray-200 dark:bg-gray-700" style={{ paddingLeft: 4 }}>
            <button className="p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors cursor-pointer">
              <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform duration-200 rotate-90" />
            </button>
            <div className="p-0.5 rounded cursor-grab">
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
            </div>
            <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">Morning Basket</span>
          </div>

          {/* Children */}
          {[
            { icon: FileText, label: "Week 14 — Am. Revolution", dot: true },
            { icon: FileText, label: "Nature Journal — Emma" },
          ].map((item) => (
            <div key={item.label} className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700" style={{ paddingLeft: 12 }}>
              <div className="p-0.5 rounded cursor-grab">
                <item.icon className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
              </div>
              {item.dot && <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 ml-1" />}
              <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">{item.label}</span>
            </div>
          ))}

          {/* Emma's Tasks folder */}
          <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700 mt-1" style={{ paddingLeft: 4 }}>
            <button className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors cursor-pointer">
              <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform duration-200" />
            </button>
            <div className="p-0.5 rounded cursor-grab">
              <CheckSquare className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
            </div>
            <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">Emma&apos;s Tasks</span>
          </div>

          <div className="group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-700" style={{ paddingLeft: 4 }}>
            <div className="p-0.5 rounded cursor-grab ml-6">
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
            </div>
            <span className="flex-1 min-w-0 ml-1.5 truncate text-xs font-medium text-gray-900 dark:text-gray-100 cursor-pointer">Living Books List</span>
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

function HSEditorPreview() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex flex-col gap-1 sm:gap-2 p-2 sm:p-4 border-b border-[var(--separator)]">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="hover:text-foreground cursor-pointer">Our Homeschool</span>
          <ChevronRight className="h-2.5 w-2.5" />
          <span className="text-foreground">Morning Basket</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h2 className="text-sm sm:text-lg font-bold truncate">Week 14 — American Revolution</h2>
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
              <div className="h-6 w-6 rounded-full bg-primary border-2 border-card flex items-center justify-center text-[9px] text-white font-medium">MJ</div>
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
            <h1>Week 14: The American Revolution</h1>
            <p>We&apos;re deep in the American Revolution this week. Emma has been asking great questions — the Boston Tea Party really grabbed her. Following her interest, so we&apos;ll spend extra time there.</p>
            <h2>5-Day Plan</h2>
            <ul>
              <li><strong>Monday</strong> — Read-aloud: <em>Johnny Tremain</em>, ch. 4. Narration after. Emma&apos;s copywork from Patrick Henry&apos;s speech.</li>
              <li><strong>Tuesday</strong> — Boston Tea Party deep dive. Liberty&apos;s Kids episode + discussion. Liam draws the harbor scene.</li>
              <li><strong>Wednesday</strong> — Paul Revere&apos;s ride. Map work. Emma&apos;s written narration.</li>
              <li><strong>Thursday</strong> — Declaration of Independence. Read key passages together.</li>
              <li><strong>Friday</strong> — Nature walk + week review. Emma&apos;s reflection essay.</li>
            </ul>
            <h2>Books &amp; Resources</h2>
            <p>Spine this month: <em>Johnny Tremain</em> by Esther Forbes. Supplement with Liberty&apos;s Kids episodes 1–4 and the DK Eyewitness: American Revolution.</p>
          </div>
          <div className="flex justify-end px-5 pb-4 text-xs text-muted-foreground">612 characters</div>
        </div>
      </div>
    </div>
  );
}

function HSAIPanelPreview() {
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
            Morning Basket
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
          <button className="h-6 w-6 rounded-md hover:bg-accent flex items-center justify-center transition-colors" title="New Conversation">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-2 flex flex-col gap-1.5">
          <div className="group relative bg-primary/10 dark:bg-accent/20 p-2 rounded-md ml-2">
            <span className="text-[10px] font-medium text-primary">You</span>
            <p className="text-[10px] text-foreground">Emma loves the Boston Tea Party — can you suggest some living books and a copywork passage?</p>
            <span className="text-[10px] text-muted-foreground/60">10:31 AM</span>
            <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button className="h-5 w-5 rounded flex items-center justify-center hover:bg-accent">
                <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          </div>

          {[
            { icon: Eye, label: "Read Morning Basket" },
            { icon: Edit3, label: "Edit Week 14" },
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
            <p className="text-[10px] text-foreground">Done — I&apos;ve added <em>The Witch of Blackbird Pond</em> and <em>Ben and Me</em> to Resources, and put a Samuel Adams copywork sentence in Tuesday&apos;s plan.</p>
            <span className="text-[10px] text-muted-foreground/60">10:32 AM</span>
          </div>
        </div>

        <div className="p-2 border-t border-border">
          <div className="rounded-lg border border-border bg-background">
            <div className="px-3 py-2">
              <span className="text-[10px] text-muted-foreground">Ask about this week...</span>
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

// ─── Use Cases Strip ─────────────────────────────────────────────────────────

export function HomeschoolUseCasesSection() {
  const useCases = [
    { icon: BookOpen, label: "Morning Planning", desc: "Prep your school day in minutes. AI drafts the plan, you make it yours." },
    { icon: ListTodo, label: "See What You Covered", desc: "Task lists per child show what got done — not just what didn't." },
    { icon: Brain, label: "Research Partner", desc: "Ask for living books, narration prompts, or unit study outlines." },
    { icon: Calendar, label: "Flexible Scheduling", desc: "Plans that absorb sick days, rabbit trails, and field trips." },
    { icon: Users, label: "Co-op Sharing", desc: "Shared drives for co-op families, classes, and group resources." },
  ];

  return (
    <section className="border-t border-border bg-muted/30 py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
          {useCases.map((uc) => (
            <div key={uc.label} className="text-center">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                <uc.icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold mb-1 text-sm">{uc.label}</h3>
              <p className="text-sm text-muted-foreground">{uc.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Progress Section ─────────────────────────────────────────────────────────

export function HomeschoolProgressSection() {
  return (
    <section className="border-t border-border bg-muted/30 py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
            See what you covered — not just what&apos;s left
          </h2>
          <p className="text-lg text-muted-foreground">
            PageSpace shows your wins, not your gaps. Each child has their own task page.
            Check things off as you go — and at the end of the week, you can actually see what you did.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <ProgressMock />

          <div className="space-y-6">
            {[
              {
                icon: CheckSquare,
                title: "Per-child task pages",
                desc: "Each child gets their own task list. Assignments show subject and completion status — no whiteboard or spreadsheet required.",
              },
              {
                icon: Sparkles,
                title: "Review what you actually taught",
                desc: "At the end of the week, ask AI to summarize what you covered. Useful for portfolios, transcripts, or just seeing your own progress.",
              },
              {
                icon: Leaf,
                title: "Plans that absorb real life",
                desc: "Rabbit trail Tuesday? Sick day Wednesday? PageSpace doesn't judge. Loop through what didn't happen and keep moving forward.",
              },
              {
                icon: Calendar,
                title: "Flexible, not rigid",
                desc: "Works for loop scheduling, Charlotte Mason rhythms, classical four-day weeks — or whatever your family calls normal.",
              },
            ].map((card) => (
              <div key={card.title} className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                    <card.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">{card.title}</h3>
                    <p className="text-sm text-muted-foreground">{card.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

interface StudentTaskProps {
  subject: string;
  task: string;
  done: boolean;
  subjectColor: string;
  dueLabel?: string;
}

function StudentTask({ subject, task, done, subjectColor, dueLabel }: StudentTaskProps) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-b-0 transition-colors ${done ? "opacity-50" : ""}`}>
      <div className="shrink-0">
        {done
          ? <CheckCircle2 className="h-4 w-4 text-primary" />
          : <Circle className="h-4 w-4 text-muted-foreground/40" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-snug ${done ? "line-through text-muted-foreground" : "text-foreground"}`}>{task}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${subjectColor}`}>{subject}</span>
          {dueLabel && <span className="text-[10px] text-muted-foreground">{dueLabel}</span>}
        </div>
      </div>
    </div>
  );
}

function ProgressMock() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full bg-violet-500 flex items-center justify-center text-[10px] font-bold text-white">E</div>
            <span className="text-sm font-medium">Emma — Week 14</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>3/5 done</span>
            <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="w-[60%] h-full bg-primary rounded-full" />
            </div>
          </div>
        </div>
        <StudentTask subject="History" task="Read-aloud: Johnny Tremain, ch. 4" done subjectColor="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" />
        <StudentTask subject="Writing" task="Copywork: Patrick Henry quote" done subjectColor="bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" />
        <StudentTask subject="History" task="Narration: Boston Tea Party" done={false} subjectColor="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" dueLabel="Today" />
        <StudentTask subject="Reading" task="Island of the Blue Dolphins, ch. 7" done={false} subjectColor="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" dueLabel="This week" />
        <StudentTask subject="Nature" task="Nature journal — leaf collection" done={false} subjectColor="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" dueLabel="Friday" />
      </div>

      <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full bg-sky-500 flex items-center justify-center text-[10px] font-bold text-white">L</div>
            <span className="text-sm font-medium">Liam — Week 14</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>4/4 done</span>
            <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="w-full h-full bg-green-500 rounded-full" />
            </div>
          </div>
        </div>
        <StudentTask subject="Math" task="Multiplication tables — 7s and 8s" done subjectColor="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" />
        <StudentTask subject="History" task="Draw: Boston Harbor scene" done subjectColor="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" />
        <StudentTask subject="Reading" task="Charlotte&apos;s Web, ch. 4–5" done subjectColor="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" />
        <StudentTask subject="Writing" task="Journal: describe your room" done subjectColor="bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" />
      </div>
    </div>
  );
}

// ─── AI Research Section ──────────────────────────────────────────────────────

export function HomeschoolAITutorSection() {
  return (
    <section className="border-t border-border py-16 md:py-24 lg:py-32 overflow-hidden">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
            An AI that already knows what you&apos;re studying
          </h2>
          <p className="text-lg text-muted-foreground">
            Because your curriculum lives in PageSpace, AI has context — ask for living book
            recommendations, narration prompts, or a rabbit-trail outline without re-explaining
            your whole approach every time.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-6 order-1 lg:order-2">
            {[
              {
                icon: Brain,
                title: "Context from your curriculum",
                desc: "PageSpace reads your lesson plans before answering. AI already knows what unit you're in, what resources you use, and what level to pitch its suggestions.",
              },
              {
                icon: Sparkles,
                title: "Follow the rabbit trails",
                desc: "Curious about something? Ask AI to expand on it, find related living books, or add a detour to this week's plan. Delight-directed learning has a planning partner now.",
              },
              {
                icon: BookOpen,
                title: "Narration and copywork help",
                desc: "Generate narration prompts for any reading passage, copywork sentences at the right level, or comprehension questions you can ask over lunch.",
              },
              {
                icon: Shield,
                title: "You stay the teacher",
                desc: "AI is a research and planning tool. You make the decisions about what your family studies and how. It just makes preparation a lot faster.",
              },
            ].map((card) => (
              <div key={card.title} className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                    <card.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">{card.title}</h3>
                    <p className="text-sm text-muted-foreground">{card.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="order-2 lg:order-1">
            <AITutorMock />
          </div>
        </div>
      </div>
    </section>
  );
}

function AITutorMock() {
  return (
    <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
      {/* Tabs */}
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

      {/* Agent selector */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent text-xs font-medium transition-colors">
          Morning Basket
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
        <button className="h-6 w-6 rounded-md hover:bg-accent flex items-center justify-center transition-colors">
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex flex-col gap-1.5 p-2 min-h-[340px] max-h-[380px] overflow-auto">
        {/* User message */}
        <div className="group relative bg-primary/10 dark:bg-accent/20 p-2 rounded-md ml-2">
          <span className="text-[10px] font-medium text-primary">You</span>
          <p className="text-[10px] text-foreground">Emma got really into the Boston Tea Party. Can you suggest some living books and a copywork passage?</p>
          <span className="text-[10px] text-muted-foreground/60">10:31 AM</span>
          <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button className="h-5 w-5 rounded flex items-center justify-center hover:bg-accent">
              <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Tool calls */}
        {[
          { icon: Eye, label: "Read Morning Basket" },
          { icon: Eye, label: "Read Week 14" },
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

        {/* AI response */}
        <div className="group relative p-2">
          <p className="text-[10px] text-foreground">Based on what you&apos;ve been reading: <em>The Witch of Blackbird Pond</em> by Elizabeth Speare fits perfectly — same colonial era, great for Emma&apos;s level. <em>Ben and Me</em> by Robert Lawson is a lighter companion. For copywork: &ldquo;It does not take a majority to prevail, but rather an irate, tireless minority.&rdquo; — Samuel Adams. About 25 words, right at her level.</p>
          <span className="text-[10px] text-muted-foreground/60">10:32 AM</span>
        </div>

        {/* Second user message */}
        <div className="group relative bg-primary/10 dark:bg-accent/20 p-2 rounded-md ml-2">
          <span className="text-[10px] font-medium text-primary">You</span>
          <p className="text-[10px] text-foreground">Perfect. Add those to this week&apos;s plan.</p>
          <span className="text-[10px] text-muted-foreground/60">10:33 AM</span>
        </div>

        {/* Tool call */}
        <div className="py-0.5 text-[11px]">
          <button className="w-full flex items-center gap-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <Edit3 className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium truncate flex-1 min-w-0">Edit Week 14</span>
            <CheckCircle2 className="h-3 w-3 text-green-500" />
          </button>
        </div>

        {/* AI response */}
        <div className="group relative p-2">
          <p className="text-[10px] text-foreground">Done — added the book suggestions under Resources and put the Samuel Adams copywork sentence in Tuesday&apos;s plan.</p>
          <span className="text-[10px] text-muted-foreground/60">10:33 AM</span>
        </div>
      </div>

      {/* Input */}
      <div className="p-2 border-t border-border">
        <div className="rounded-lg border border-border bg-background">
          <div className="px-3 py-2">
            <span className="text-[10px] text-muted-foreground">Ask about this week...</span>
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
  );
}

// ─── FAQ Section ──────────────────────────────────────────────────────────────

const faqs = [
  {
    q: "Is this going to be another tool I start beautifully in September and abandon by October?",
    a: "That's the realest question we hear. Most planners fail because they're built around what you haven't done yet. PageSpace shows what you did — check off what you covered, and the record builds itself as you go. There's no elaborate setup to maintain, no blank pages making you feel behind. You just use it each day and look back at the end of the week.",
  },
  {
    q: "Do I need to be tech-savvy to use this?",
    a: "No. If you can use a notes app or Google Docs, you can use PageSpace. You create pages, type in them, and ask AI questions in a chat. The learning curve is a few minutes, not a few days.",
  },
  {
    q: "How much does it cost?",
    a: "PageSpace has a free tier that includes unlimited pages, AI chat, and task lists — everything you need to get started. Paid plans start at $15/month if you want more credits or storage. No credit card required to sign up.",
  },
  {
    q: "Is my family's information private?",
    a: "Yes. Your workspace content is private to your account. We don't sell your data or use your family's content to train AI models. All sessions are encrypted in transit and at rest.",
  },
  {
    q: "Does it work for Charlotte Mason, Classical, eclectic — or the approach we made up ourselves?",
    a: "PageSpace is a workspace, not a curriculum. There's no predetermined structure you have to fit into. You set it up however matches your family — morning basket folders, loop schedules, subject-by-child pages, or something entirely your own. AI suggestions pull from the context you've built, not a generic template.",
  },
  {
    q: "Can I use it with a co-op group?",
    a: "Yes. You can create a shared drive and invite other families. Each family manages their own pages while sharing lesson plans, schedules, and resources with the group. Works well for co-op classes, book clubs, and shared unit studies.",
  },
];

export function HomeschoolFAQSection() {
  return (
    <section className="border-t border-border bg-muted/30 py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
            Questions we actually hear
          </h2>
          <p className="text-lg text-muted-foreground">
            Honest answers to the things homeschool families ask us.
          </p>
        </div>

        <div className="mx-auto max-w-3xl divide-y divide-border rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          {faqs.map((faq) => (
            <details key={faq.q} className="group px-6 py-5">
              <summary className="flex cursor-pointer items-center justify-between gap-4 list-none font-semibold text-base">
                {faq.q}
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                {faq.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── CTA Section ──────────────────────────────────────────────────────────────

export function HomeschoolCTASection() {
  return (
    <section className="border-t border-border bg-gradient-to-b from-muted/50 to-background py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-6">
            Start your school year with a clear workspace
          </h2>

          <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-10">
            Free to start. Takes five minutes. Set up your first folder, ask AI to draft this week&apos;s plan, and see how much lighter planning feels.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
            <Button size="lg" asChild className="w-full sm:w-auto">
              <a href={`${APP_URL}/auth/signup`}>
                Start free — no card required
                <ArrowRight className="ml-2 h-4 w-4" />
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
              <Link href="/pricing">Compare plans</Link>
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 pt-8 border-t border-border text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Unlimited pages and documents
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              AI chat included on free tier
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Task lists for every child
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Works on Mac, Windows, iOS, Android
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
