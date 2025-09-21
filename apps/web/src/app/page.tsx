import Link from "next/link";
import { GitMerge, Folder, Code, MessageSquare, Check, Shield, Zap, Users, HardDrive } from "lucide-react";
import AuthButtons from "@/components/shared/AuthButtons";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ContactForm from "@/components/shared/ContactForm";

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
        <section className="w-full py-16 md:py-24 lg:py-32 bg-muted">
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
        <section className="w-full py-20 md:py-32 lg:py-40 bg-background">
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center space-y-12">
              <div className="space-y-4 text-center">
                <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
                  Choose Your PageSpace Plan
                </h2>
                <p className="mx-auto max-w-[800px] text-lg text-muted-foreground md:text-xl">
                  Start free, upgrade to Pro, or scale to enterprise deployment.
                </p>
              </div>
              <div className="grid gap-8 lg:grid-cols-3 max-w-6xl w-full">
                {/* Free Tier */}
                <Card className="relative border-2 hover:border-primary/50 transition-colors flex flex-col">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <Badge variant="secondary">Get Started</Badge>
                      <div className="text-right">
                        <div className="text-3xl font-bold">Free</div>
                      </div>
                    </div>
                    <CardTitle>Free</CardTitle>
                    <CardDescription>
                      Full PageSpace features with daily limits
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 flex-grow">
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3">
                        <Check className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>500MB storage</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Zap className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>20 daily PageSpace AI calls</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Code className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>Bring your own AI API keys</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Users className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>Real-time collaboration</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <GitMerge className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>Hierarchical AI agents</span>
                      </li>
                    </ul>
                    <div className="pt-4 border-t">
                      <p className="text-sm text-muted-foreground">
                        Perfect for trying out PageSpace
                      </p>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button asChild variant="outline" className="w-full" size="lg">
                      <Link href="/auth/signup">
                        Get Started
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>

                {/* Pro Tier */}
                <Card className="relative border-2 border-primary hover:border-primary/70 transition-colors flex flex-col">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <Badge variant="default">Most Popular</Badge>
                      <div className="text-right">
                        <div className="text-3xl font-bold">$29.99</div>
                        <div className="text-sm text-muted-foreground">/month</div>
                      </div>
                    </div>
                    <CardTitle>Pro</CardTitle>
                    <CardDescription>
                      Everything you need for individual productivity
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 flex-grow">
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3">
                        <Check className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>2GB storage for documents, PDFs, and images</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Zap className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>50 daily PageSpace AI calls</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Shield className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>10 daily &quot;Extra Thinking&quot; sessions (advanced reasoning)</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Users className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>Real-time collaboration</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <GitMerge className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>Hierarchical AI agents</span>
                      </li>
                    </ul>
                    <div className="pt-4 border-t">
                      <p className="text-sm text-muted-foreground">
                        Perfect for individuals, freelancers, and personal projects
                      </p>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button asChild className="w-full" size="lg">
                      <Link href="/settings/billing">
                        Get Started
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>

                {/* Business Tier */}
                <Card className="relative border-2 hover:border-primary/50 transition-colors flex flex-col">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">Business</Badge>
                      <div className="text-right">
                        <div className="text-3xl font-bold">$199.99</div>
                        <div className="text-sm text-muted-foreground">/month</div>
                      </div>
                    </div>
                    <CardTitle>Business</CardTitle>
                    <CardDescription>
                      High-volume usage for businesses and teams
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 flex-grow">
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3">
                        <HardDrive className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>50GB storage for large projects</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Zap className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>500 daily PageSpace AI calls</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Shield className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>50 daily &quot;Extra Thinking&quot; sessions</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Users className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>Real-time collaboration</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <GitMerge className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>Hierarchical AI agents</span>
                      </li>
                    </ul>
                    <div className="pt-4 border-t">
                      <p className="text-sm text-muted-foreground">
                        Perfect for businesses and high-volume users
                      </p>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button asChild variant="outline" className="w-full" size="lg">
                      <Link href="/settings/billing">
                        Get Started
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              </div>
            </div>
          </div>
        </section>
        <section className="w-full py-20 md:py-32 lg:py-40 bg-muted text-foreground">
          <div className="container mx-auto px-4 md:px-6 max-w-2xl">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl mb-4">
                Contact Us
              </h2>
              <p className="text-lg text-muted-foreground max-w-md mx-auto">
                Have questions? We&apos;d love to hear from you.
              </p>
            </div>
            <ContactForm />
          </div>
        </section>
      </main>
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