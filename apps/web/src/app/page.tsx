import Link from "next/link";
import { FileText, GitMerge, Share2, Folder, Code, MessageSquare } from "lucide-react";
import AuthButtons from "@/components/shared/AuthButtons";

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="w-full border-b">
        <div className="container mx-auto flex h-14 items-center px-4 sm:px-6 lg:px-8">
          <Link className="flex items-center justify-center" href="#">
            <span className="text-xl font-semibold">PageSpace</span>
          </Link>
          <nav className="ml-auto flex gap-4 sm:gap-6">
            <AuthButtons />
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <section className="w-full py-20 md:py-32 lg:py-40 bg-background text-foreground">
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center space-y-6 text-center">
              <div className="space-y-4">
                <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl lg:text-7xl/none">
                  Your entire world, organized.
                </h1>
                <p className="mx-auto max-w-[700px] text-lg text-muted-foreground md:text-xl">
                  A new kind of workspace where everything is a flexible page,
                  anything can be nested, and anything can be mentioned.
                </p>
              </div>
              <div className="space-y-2">
                <Link
                  className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  href="/dashboard"
                >
                  Join open beta!
                </Link>
              </div>
            </div>
          </div>
        </section>
        <section className="w-full py-16 md:py-24 lg:py-32 bg-muted/30">
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center space-y-12 text-center">
              <div className="space-y-4">
                <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
                  Where familiar meets extraordinary
                </h2>
                <p className="mx-auto max-w-[800px] text-lg text-muted-foreground md:text-xl">
                  The tools you love, unified and amplified by AI that doesn&apos;t just suggest—it builds.
                </p>
              </div>
              <div className="grid gap-8 lg:grid-cols-3 max-w-6xl">
                <div className="flex flex-col items-center space-y-4 text-center">
                  <Folder className="w-12 h-12 text-primary" />
                  <div className="space-y-2">
                    <h3 className="text-xl font-semibold">Drive&apos;s Organization</h3>
                    <p className="text-muted-foreground text-sm">
                      File structure you understand, with AI that organizes intelligently as you work.
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-center space-y-4 text-center">
                  <Code className="w-12 h-12 text-primary" />
                  <div className="space-y-2">
                    <h3 className="text-xl font-semibold">Cursor&apos;s Precision</h3>
                    <p className="text-muted-foreground text-sm">
                      Agentic AI editing that makes exact changes, refactors code, and builds features.
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-center space-y-4 text-center">
                  <MessageSquare className="w-12 h-12 text-primary" />
                  <div className="space-y-2">
                    <h3 className="text-xl font-semibold">Beyond Slack + Notion</h3>
                    <p className="text-muted-foreground text-sm">
                      Nested channels with full context, project scaffolding that evolves with your ideas.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className="w-full py-20 md:py-32 lg:py-40 bg-card text-card-foreground">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid gap-12 lg:grid-cols-3">
              <div className="flex flex-col items-center justify-center space-y-4 text-center">
                <FileText className="w-12 h-12" />
                <div className="space-y-2">
                  <h3 className="text-2xl font-bold">Everything is a Page</h3>
                  <p className="text-muted-foreground">
                    Documents, folders, chats, and even AI assistants are all
                    flexible pages. Mix and match them to create the perfect
                    workflow.
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-center justify-center space-y-4 text-center">
                <GitMerge className="w-12 h-12" />
                <div className="space-y-2">
                  <h3 className="text-2xl font-bold">The Infinite Tree</h3>
                  <p className="text-muted-foreground">
                    Nest anything inside anything. Give your work structure and
                    context that evolves with your ideas.
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-center justify-center space-y-4 text-center">
                <Share2 className="w-12 h-12" />
                <div className="space-y-2">
                  <h3 className="text-2xl font-bold">
                    Mention Anything, Anywhere
                  </h3>
                  <p className="text-muted-foreground">
                    Link pages, people, or conversations to create a web of
                    knowledge. Your AI understands the context of every mention.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <section className="w-full py-20 md:py-32 lg:py-40 bg-background text-foreground">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex flex-col items-center space-y-6 text-center">
            <div className="space-y-4">
              <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
                Ready to build your new workspace?
              </h2>
              <p className="mx-auto max-w-[600px] text-lg text-muted-foreground md:text-xl">
                Sign up for free and start organizing your world.
              </p>
            </div>
            <div className="space-y-2">
              <Link
                className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                href="/dashboard"
              >
                Join open beta!
              </Link>
            </div>
          </div>
        </div>
      </section>
      <footer className="w-full border-t bg-background text-foreground">
        <div className="container mx-auto flex flex-col gap-2 sm:flex-row py-6 shrink-0 items-center px-4 md:px-6">
          <p className="text-xs text-muted-foreground">
            © 2025 pagespace. All rights reserved.
          </p>
          <nav className="sm:ml-auto flex gap-4 sm:gap-6">
            <Link
              className="text-xs hover:underline underline-offset-4 text-muted-foreground"
              href="/terms"
            >
              Terms of Service
            </Link>
            <Link
              className="text-xs hover:underline underline-offset-4 text-muted-foreground"
              href="/privacy"
            >
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}


