import Link from "next/link";
import { GitMerge, Folder, Code, MessageSquare, Shield, Zap, Users, HardDrive } from "lucide-react";
import AuthButtons from "@/components/shared/AuthButtons";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ContactForm from "@/components/shared/ContactForm";
import PageSpaceDemo from "@/components/landing/PageSpaceDemo";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PageSpace - AI-Powered Unified Workspace for Teams",
  description: "A unified workspace combining documents, collaborative channels, and AI agents. Built for creators, teams, and businesses. Real-time collaboration with hierarchical AI agents.",
  keywords: ["workspace", "AI workspace", "collaborative workspace", "team collaboration", "AI agents", "document management", "real-time collaboration", "PageSpace"],
  authors: [{ name: "PageSpace" }],
  creator: "PageSpace",
  publisher: "PageSpace",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://pagespace.ai',
    siteName: 'PageSpace',
    title: 'PageSpace - AI-Powered Unified Workspace for Teams',
    description: 'A unified workspace combining documents, collaborative channels, and AI agents. Built for creators, teams, and businesses.',
    images: [
      {
        url: 'https://pagespace.ai/og-image.png',
        width: 1200,
        height: 630,
        alt: 'PageSpace - Unified Workspace',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PageSpace - AI-Powered Unified Workspace for Teams',
    description: 'A unified workspace combining documents, collaborative channels, and AI agents. Built for creators, teams, and businesses.',
    images: ['https://pagespace.ai/og-image.png'],
    creator: '@pagespace',
  },
  alternates: {
    canonical: 'https://pagespace.ai',
  },
};

export default function Home() {
  const organizationSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "PageSpace",
    "url": "https://pagespace.ai",
    "logo": "https://pagespace.ai/logo.png",
    "description": "A unified workspace combining documents, collaborative channels, and AI agents.",
    "sameAs": [
      "https://github.com/2witstudios/PageSpace"
    ]
  };

  const webApplicationSchema = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "PageSpace",
    "url": "https://pagespace.ai",
    "applicationCategory": "BusinessApplication",
    "operatingSystem": "Web Browser, Windows, macOS, Linux",
    "offers": [
      {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "USD",
        "name": "Free Plan"
      },
      {
        "@type": "Offer",
        "price": "15",
        "priceCurrency": "USD",
        "name": "Pro Plan"
      },
      {
        "@type": "Offer",
        "price": "50",
        "priceCurrency": "USD",
        "name": "Founder Plan"
      },
      {
        "@type": "Offer",
        "price": "100",
        "priceCurrency": "USD",
        "name": "Business Plan"
      }
    ],
    "description": "A unified workspace combining documents, collaborative channels, and AI agents. Built for creators, teams, and businesses.",
    "screenshot": "https://pagespace.ai/og-image.png",
    "featureList": [
      "Real-time collaboration",
      "AI-powered agents",
      "Document management",
      "Collaborative channels",
      "Hierarchical AI agents",
      "File organization"
    ]
  };

  return (
    <div className="flex flex-col min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webApplicationSchema) }}
      />
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
                  A Unified Workspace for Every Idea
                </h1>
                <p className="mx-auto max-w-[700px] text-lg text-muted-foreground md:text-xl">
                  Documents, collaborative channels, and AI agents—all in one place. Built for creators, teams, and businesses.
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="flex gap-4">
                  <Link
                    className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    href="/dashboard"
                  >
                    Get Started
                  </Link>
                  <Link
                    className="inline-flex h-12 items-center justify-center rounded-md border border-input bg-background px-8 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    href="#pricing"
                  >
                    View Pricing
                  </Link>
                </div>
                <p className="text-xs text-muted-foreground">
                  Also available as a{" "}
                  <Link href="/downloads" className="underline underline-offset-2 hover:text-foreground">
                    desktop app for macOS, Windows, and Linux
                  </Link>
                </p>
              </div>
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center space-y-12">
              <PageSpaceDemo />
            </div>
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
        <section id="pricing" className="w-full py-20 md:py-32 lg:py-40 bg-background">
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center space-y-12">
              <div className="space-y-4 text-center">
                <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
                  Choose Your PageSpace Plan
                </h2>
                <p className="mx-auto max-w-[800px] text-lg text-muted-foreground md:text-xl">
                  Start free with full features, upgrade for more AI calls and storage.
                </p>
              </div>

              {/* Free Tier - Full Width */}
              <Card className="w-full max-w-4xl border-2 hover:border-primary/50 transition-colors">
                <CardHeader className="text-center">
                  <Badge variant="secondary" className="w-fit mx-auto mb-2">Always Free</Badge>
                  <CardTitle className="text-2xl">Start with PageSpace Free</CardTitle>
                  <CardDescription>Full features with daily limits - upgrade anytime</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-6 text-sm">
                    <div className="flex flex-col items-center gap-2 text-center">
                      <HardDrive className="w-5 h-5 text-primary" />
                      <span>500MB storage</span>
                    </div>
                    <div className="flex flex-col items-center gap-2 text-center">
                      <Zap className="w-5 h-5 text-primary" />
                      <span>50 daily AI calls</span>
                    </div>
                    <div className="flex flex-col items-center gap-2 text-center">
                      <Code className="w-5 h-5 text-primary" />
                      <span>Your own API keys (unlimited)</span>
                    </div>
                    <div className="flex flex-col items-center gap-2 text-center">
                      <Users className="w-5 h-5 text-primary" />
                      <span>Real-time collaboration</span>
                    </div>
                    <div className="flex flex-col items-center gap-2 text-center">
                      <GitMerge className="w-5 h-5 text-primary" />
                      <span>Hierarchical AI agents</span>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="justify-center">
                  <Button asChild variant="outline" size="lg">
                    <Link href="/auth/signup">Get Started Free</Link>
                  </Button>
                </CardFooter>
              </Card>

              {/* Paid Tiers - 3 Column Grid */}
              <div className="grid gap-8 lg:grid-cols-3 max-w-6xl w-full">
                {/* Pro Tier */}
                <Card className="relative border-2 hover:border-primary/50 transition-colors flex flex-col">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <Badge variant="secondary">Pro</Badge>
                      <div className="text-right">
                        <div className="text-3xl font-bold">$15</div>
                        <div className="text-sm text-muted-foreground">/month</div>
                      </div>
                    </div>
                    <CardTitle>Pro</CardTitle>
                    <CardDescription>
                      For individuals and freelancers
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 flex-grow">
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3">
                        <HardDrive className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>2GB storage</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Zap className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>200 daily AI calls</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Shield className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>50 daily Pro AI sessions</span>
                      </li>
                    </ul>
                  </CardContent>
                  <CardFooter>
                    <Button asChild variant="outline" className="w-full" size="lg">
                      <Link href="/settings/billing">Upgrade to Pro</Link>
                    </Button>
                  </CardFooter>
                </Card>

                {/* Founder Tier */}
                <Card className="relative border-2 border-emerald-500 hover:border-emerald-400 transition-colors flex flex-col">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <Badge className="bg-emerald-500 hover:bg-emerald-600">Best Value</Badge>
                      <div className="text-right">
                        <div className="text-3xl font-bold">$50</div>
                        <div className="text-sm text-muted-foreground">/month</div>
                      </div>
                    </div>
                    <CardTitle>Founder</CardTitle>
                    <CardDescription>
                      For power users who want maximum value
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 flex-grow">
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3">
                        <HardDrive className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                        <span>10GB storage</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Zap className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                        <span>500 daily AI calls</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Shield className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                        <span>100 daily Pro AI sessions</span>
                      </li>
                    </ul>
                  </CardContent>
                  <CardFooter>
                    <Button asChild className="w-full bg-emerald-500 hover:bg-emerald-600" size="lg">
                      <Link href="/settings/billing">Upgrade to Founder</Link>
                    </Button>
                  </CardFooter>
                </Card>

                {/* Business Tier */}
                <Card className="relative border-2 hover:border-primary/50 transition-colors flex flex-col">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">Business</Badge>
                      <div className="text-right">
                        <div className="text-3xl font-bold">$100</div>
                        <div className="text-sm text-muted-foreground">/month</div>
                      </div>
                    </div>
                    <CardTitle>Business</CardTitle>
                    <CardDescription>
                      For teams and high-volume users
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 flex-grow">
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3">
                        <HardDrive className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>50GB storage</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Zap className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>1000 daily AI calls</span>
                      </li>
                      <li className="flex items-center gap-3">
                        <Shield className="w-5 h-5 text-primary flex-shrink-0" />
                        <span>500 daily Pro AI sessions</span>
                      </li>
                    </ul>
                  </CardContent>
                  <CardFooter>
                    <Button asChild variant="outline" className="w-full" size="lg">
                      <Link href="/settings/billing">Upgrade to Business</Link>
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
              href="https://github.com/2witstudios/PageSpace"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </Link>
            <Link
              className="text-xs hover:underline underline-offset-4 text-muted-foreground"
              href="/downloads"
            >
              Downloads
            </Link>
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