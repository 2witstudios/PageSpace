import Link from "next/link";
import { Sparkles, ArrowRight, Play, FolderPlus, FileText, MessageSquare, CheckSquare, Calendar, Bot, Users, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";

export const metadata = pageMetadata.tour;

interface TourStep {
  number: number;
  title: string;
  description: string;
  icon: React.ReactNode;
  features: string[];
}

const tourSteps: TourStep[] = [
  {
    number: 1,
    title: "Create Your Workspace",
    description: "Start by creating a workspace—your home base for organizing projects, teams, and ideas. Each workspace gets its own AI context.",
    icon: <FolderPlus className="h-6 w-6" />,
    features: [
      "Name your workspace and invite team members",
      "Set up workspace-level AI preferences",
      "Choose from templates or start blank",
      "Configure visibility and permissions",
    ],
  },
  {
    number: 2,
    title: "Add Documents with AI",
    description: "Create documents with AI assistance built right in. Get suggestions, edits, and completions as you write.",
    icon: <FileText className="h-6 w-6" />,
    features: [
      "Start typing and AI suggests completions",
      "Highlight text to request AI edits",
      "Toggle between rich text and markdown",
      "One-click rollback for any AI change",
    ],
  },
  {
    number: 3,
    title: "Collaborate in Channels",
    description: "Create channels for team discussions. @mention AI agents to bring them into any conversation.",
    icon: <MessageSquare className="h-6 w-6" />,
    features: [
      "@mention specialized AI agents",
      "Threaded discussions keep things organized",
      "Share documents directly in chat",
      "Real-time collaboration with your team",
    ],
  },
  {
    number: 4,
    title: "Manage Tasks with AI",
    description: "Create tasks and assign them to team members or AI agents. AI can complete research and drafting tasks autonomously.",
    icon: <CheckSquare className="h-6 w-6" />,
    features: [
      "Assign tasks to AI or humans",
      "AI works autonomously on assigned tasks",
      "Track progress with rollups",
      "Integrate tasks with documents and channels",
    ],
  },
  {
    number: 5,
    title: "View Your Calendar",
    description: "See all your events, deadlines, and AI work sessions in one unified calendar view.",
    icon: <Calendar className="h-6 w-6" />,
    features: [
      "Unified view across all workspaces",
      "Google Calendar integration",
      "Task deadlines appear automatically",
      "AI scheduling awareness",
    ],
  },
];

export default function TourPage() {
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
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
              <Play className="h-4 w-4 text-primary" />
              <span className="text-muted-foreground">Product Tour</span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              See PageSpace in action
            </h1>
            <p className="text-lg text-muted-foreground mb-8">
              Walk through the key workflows that make PageSpace different.
              From creating your first workspace to collaborating with AI agents.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" asChild>
                <a href="#step-1">
                  Start the Tour
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href={`${APP_URL}/auth/signup`}>
                  Try It Yourself
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* AI Architecture Overview */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-4xl">
            <div className="rounded-2xl border border-border bg-card p-8 md:p-12">
              <div className="flex flex-col md:flex-row items-start gap-8">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 flex-shrink-0">
                  <Bot className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold mb-4">The AI Architecture</h2>
                  <p className="text-muted-foreground mb-6">
                    Before we dive in, here&apos;s what makes PageSpace unique: AI isn&apos;t just a chatbot—it&apos;s woven
                    into your workspace. You have a <strong>Global Assistant</strong> that follows you everywhere,
                    plus <strong>Page Agents</strong> that live in your file tree with specialized knowledge.
                  </p>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                        <Users className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">Global Assistant</h3>
                        <p className="text-sm text-muted-foreground">Your personal AI across all workspaces</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                        <Bot className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">Page Agents</h3>
                        <p className="text-sm text-muted-foreground">Specialized AI with custom prompts</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Tour Steps */}
      {tourSteps.map((step, index) => (
        <section
          key={step.number}
          id={`step-${step.number}`}
          className={`py-16 md:py-24 ${index % 2 === 1 ? "bg-muted/30" : ""}`}
        >
          <div className="container mx-auto px-4 md:px-6">
            <div className="mx-auto max-w-5xl">
              <div className={`flex flex-col ${index % 2 === 1 ? "lg:flex-row-reverse" : "lg:flex-row"} items-center gap-12`}>
                {/* Content */}
                <div className="flex-1">
                  <div className="flex items-center gap-4 mb-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold text-xl">
                      {step.number}
                    </div>
                    <h2 className="text-2xl md:text-3xl font-bold">{step.title}</h2>
                  </div>
                  <p className="text-lg text-muted-foreground mb-8">
                    {step.description}
                  </p>
                  <ul className="space-y-4">
                    {step.features.map((feature, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <ChevronRight className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Navigation to next step */}
                  <div className="mt-8 flex items-center gap-4">
                    {step.number < tourSteps.length ? (
                      <Button variant="outline" asChild>
                        <a href={`#step-${step.number + 1}`}>
                          Next: {tourSteps[step.number].title}
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </a>
                      </Button>
                    ) : (
                      <Button asChild>
                        <a href={`${APP_URL}/auth/signup`}>
                          Start Using PageSpace
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </a>
                      </Button>
                    )}
                  </div>
                </div>

                {/* Visual Mockup */}
                <div className="flex-1 w-full">
                  <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                    {/* Window Chrome */}
                    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
                      <div className="flex gap-1.5">
                        <div className="h-3 w-3 rounded-full bg-red-400/80" />
                        <div className="h-3 w-3 rounded-full bg-yellow-400/80" />
                        <div className="h-3 w-3 rounded-full bg-green-400/80" />
                      </div>
                      <div className="flex-1 text-center">
                        <div className="inline-flex items-center gap-2 rounded-md bg-muted px-3 py-1 text-xs text-muted-foreground">
                          <span>pagespace.ai</span>
                        </div>
                      </div>
                    </div>

                    {/* Content Preview */}
                    <div className="p-8 min-h-[300px] flex items-center justify-center bg-gradient-to-br from-muted/50 to-background">
                      <div className="text-center">
                        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                          {step.icon}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      ))}

      {/* CTA Section */}
      <section className="py-16 md:py-24 bg-gradient-to-b from-muted/30 to-background">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-3xl font-bold mb-4">Ready to try it yourself?</h2>
            <p className="text-lg text-muted-foreground mb-8">
              The best way to understand PageSpace is to use it.
              Start free—no credit card required.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" asChild>
                <a href={`${APP_URL}/auth/signup`}>
                  Get Started Free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/pricing">
                  View Pricing
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
