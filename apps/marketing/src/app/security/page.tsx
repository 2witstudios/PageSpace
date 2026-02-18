import Link from "next/link";
import {
  Sparkles,
  Shield,
  Lock,
  Server,
  CheckCircle2,
  ArrowRight,
  Globe,
  Users,
  Key,
  Activity,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import { APP_URL } from "@/lib/metadata";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security | PageSpace",
  description:
    "Defense-in-depth security with opaque session tokens, per-event WebSocket authorization, and distributed rate limiting.",
};

export default function SecurityPage() {
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
            <Link
              href="/pricing"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Pricing
            </Link>
            <Link
              href="/downloads"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Downloads
            </Link>
            <Link
              href="/docs"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Docs
            </Link>
            <Link
              href="/blog"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
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
      <section className="py-16 md:py-24 lg:py-32">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-4xl text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary mb-6">
              <Shield className="h-4 w-4" />
              Defense in Depth
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Security Built Into
              <br />
              <span className="text-primary">Every Layer</span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
              PageSpace uses opaque session tokens, per-event authorization, and distributed
              rate limiting to protect your data at every step.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" asChild>
                <Link href="/docs/security">
                  Security Documentation
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/blog/security-architecture-deep-dive">Read the Deep Dive</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Key Features */}
      <section className="pb-16 md:pb-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex flex-wrap items-center justify-center gap-8 text-muted-foreground">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <span className="font-medium">Hash-Only Token Storage</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <span className="font-medium">Per-Event Authorization</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <span className="font-medium">Distributed Rate Limiting</span>
            </div>
            <div className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              <span className="font-medium">TLS Encrypted</span>
            </div>
          </div>
        </div>
      </section>

      {/* Session Security Section */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold mb-4">Opaque Session Tokens</h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Unlike JWTs that can be decoded by anyone, PageSpace uses opaque tokens with
                hash-only storage for maximum security.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
              {/* Why Opaque Tokens */}
              <div className="rounded-2xl border border-border bg-card p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-6">
                  <Key className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3">Hash-Only Storage</h3>
                <p className="text-muted-foreground mb-6">
                  We never store your actual session token—only a SHA-256 hash. Even if our
                  database were compromised, attackers couldn&apos;t use the hashes.
                </p>
                <ul className="space-y-3">
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>256 bits of entropy per token</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>SHA-256 one-way hashing</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Stateful validation on every request</span>
                  </li>
                </ul>
              </div>

              {/* Instant Revocation */}
              <div className="rounded-2xl border border-border bg-card p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-6">
                  <Timer className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3">Instant Revocation</h3>
                <p className="text-muted-foreground mb-6">
                  Sessions can be revoked immediately—no waiting for token expiration. Password
                  changes invalidate all existing sessions.
                </p>
                <ul className="space-y-3">
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Revoke individual sessions or all sessions</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Token versioning on password change</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Admin role versioning prevents privilege escalation</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Real-Time Security Section */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold mb-4">Per-Event WebSocket Authorization</h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Real-time collaboration doesn&apos;t mean relaxed security. Every write operation
                is authorized in real-time.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              <div className="rounded-xl border border-border bg-card p-6">
                <Server className="h-8 w-8 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2">Write Authorization</h3>
                <p className="text-sm text-muted-foreground">
                  Document updates, file uploads, and task changes are re-authorized on every
                  event—not just at connection time.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-card p-6">
                <Shield className="h-8 w-8 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2">Short-Lived Tokens</h3>
                <p className="text-sm text-muted-foreground">
                  Socket tokens expire in 5 minutes, limiting exposure if intercepted. Connection
                  requires fresh authentication.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-card p-6">
                <Globe className="h-8 w-8 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2">Signed Broadcasts</h3>
                <p className="text-sm text-muted-foreground">
                  Inter-service communication uses HMAC-SHA256 signatures with timestamp
                  validation to prevent replay attacks.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Rate Limiting Section */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <h2 className="text-3xl font-bold mb-4">Distributed Rate Limiting</h2>
                <p className="text-lg text-muted-foreground mb-6">
                  Protection against brute force attacks with rate limiting that persists across
                  restarts and IP changes.
                </p>
                <ul className="space-y-4">
                  <li className="flex items-start gap-3">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 flex-shrink-0 mt-0.5">
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <span className="font-medium">Login protection</span>
                      <p className="text-sm text-muted-foreground">
                        5 attempts per 15 minutes, per IP and per email
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 flex-shrink-0 mt-0.5">
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <span className="font-medium">Account lockout</span>
                      <p className="text-sm text-muted-foreground">
                        15-minute lockout after 10 failed attempts (database-backed)
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 flex-shrink-0 mt-0.5">
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <span className="font-medium">Signup throttling</span>
                      <p className="text-sm text-muted-foreground">
                        3 signups per hour to prevent abuse
                      </p>
                    </div>
                  </li>
                </ul>
              </div>
              <div className="rounded-2xl border border-border bg-card p-8">
                <h3 className="font-semibold mb-6">Why Database-Backed Lockout?</h3>
                <div className="space-y-4 text-sm">
                  <div className="flex items-start gap-3">
                    <Activity className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-medium">Persists across restarts</span>
                      <p className="text-muted-foreground">
                        Lockout state isn&apos;t lost when servers restart
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-medium">Works across IPs</span>
                      <p className="text-muted-foreground">
                        Attackers can&apos;t bypass by changing IP addresses
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Timer className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-medium">Automatic unlock</span>
                      <p className="text-muted-foreground">
                        Lockout expires automatically after 15 minutes
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Authentication Section */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold mb-4">Authentication</h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Multiple secure authentication methods with strong password requirements and
                OAuth integration.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
              {/* Password Auth */}
              <div className="rounded-2xl border border-border bg-card p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-6">
                  <Lock className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3">Email & Password</h3>
                <p className="text-muted-foreground mb-6">
                  Strong password requirements with bcrypt hashing (cost factor 12).
                </p>
                <ul className="space-y-3 text-sm">
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Minimum 12 characters</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Uppercase, lowercase, and numbers required</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>bcrypt with cost factor 12</span>
                  </li>
                </ul>
              </div>

              {/* OAuth */}
              <div className="rounded-2xl border border-border bg-card p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-6">
                  <Globe className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3">OAuth (Google & Apple)</h3>
                <p className="text-muted-foreground mb-6">
                  Secure OAuth flows with signed state parameters and strict redirect validation.
                </p>
                <ul className="space-y-3 text-sm">
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>HMAC-signed state parameters</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Strict redirect URL validation</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                    <span>Authorization code flow only (no implicit)</span>
                  </li>
                </ul>
              </div>
            </div>

            {/* CSRF Protection */}
            <div className="mt-8 rounded-2xl border border-border bg-card p-8">
              <div className="flex items-start gap-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 flex-shrink-0">
                  <ShieldCheck className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-2">CSRF Protection</h3>
                  <p className="text-muted-foreground mb-4">
                    All state-changing requests require CSRF validation with HMAC-signed tokens and
                    timing-safe comparison. Even login forms have CSRF protection via a separate
                    pre-login system.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-900/30 px-3 py-1 text-xs font-medium text-green-700 dark:text-green-400">
                      <CheckCircle2 className="h-3 w-3" />
                      HMAC-SHA256 signed
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-900/30 px-3 py-1 text-xs font-medium text-green-700 dark:text-green-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Timing-safe validation
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-900/30 px-3 py-1 text-xs font-medium text-green-700 dark:text-green-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Pre-login protection
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Enterprise CTA */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mx-auto mb-6">
              <Users className="h-8 w-8 text-primary" />
            </div>
            <h2 className="text-3xl font-bold mb-4">Questions About Security?</h2>
            <p className="text-lg text-muted-foreground mb-8">
              Read our security documentation or contact us for more details about our security
              practices.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" asChild>
                <Link href="/docs/security">
                  Security Docs
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/contact">Contact Us</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
