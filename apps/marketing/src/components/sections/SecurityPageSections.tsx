import Link from "next/link";
import {
  Shield,
  Lock,
  Server,
  CheckCircle2,
  ArrowRight,
  Globe,
  Key,
  Activity,
  ShieldCheck,
  Timer,
  Users,
  Fingerprint,
  Share2,
  ShieldAlert,
  FileSearch,
  Link2Off,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function SecurityHero() {
  return (
    <section className="py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary mb-6">
            <Shield className="h-4 w-4" />
            Defense in Depth
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
            The safe place to do
            <br />
            <span className="text-primary">serious work with AI</span>
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
            Hash-chain audit logs, content-aware upload safety, explicit per-page permissions — real security primitives, engineered in. Every claim on this page maps to source you can inspect.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button size="lg" asChild>
              <Link href="/docs/security">
                Security Documentation
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/docs/security/zero-trust">Zero-Trust Architecture</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SecurityKeyFeatures() {
  const features = [
    { label: "Hash-chain audit log" },
    { label: "Content-aware uploads" },
    { label: "Explicit per-page access" },
    { label: "Hash-only session tokens" },
    { label: "Per-event authorization" },
    { label: "Distributed rate limiting" },
    { label: "TLS encrypted", icon: Lock },
  ];

  return (
    <section className="pb-16 md:pb-24">
      <div className="container mx-auto px-4 md:px-6">
        <div className="flex flex-wrap items-center justify-center gap-8 text-muted-foreground">
          {features.map((f) => (
            <div key={f.label} className="flex items-center gap-2">
              {f.icon ? <f.icon className="h-5 w-5 text-primary" /> : <CheckCircle2 className="h-5 w-5 text-green-500" />}
              <span className="font-medium">{f.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SessionSecuritySection() {
  return (
    <section className="py-16 md:py-24 bg-muted/30">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Opaque Session Tokens</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              PageSpace uses opaque session tokens with hash-only storage. Tokens carry no
              embedded claims — everything is validated server-side on every request.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            <FeatureCard
              icon={Key}
              title="Hash-Only Storage"
              description="We never store the session token itself — only its SHA3-256 hash. A compromised database snapshot does not yield usable tokens."
              items={["High-entropy random tokens", "SHA3-256 one-way hashing", "Server-side validation on every request"]}
            />
            <FeatureCard
              icon={Timer}
              title="Instant Revocation"
              description="Sessions can be revoked immediately — no waiting for expiry. Administrative actions invalidate every outstanding session for a user atomically."
              items={["Revoke individual sessions or all sessions", "Atomic log-out-everywhere for credential reset and suspension", "Timing-safe comparisons prevent leaking info via response time"]}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export function WebSocketSecuritySection() {
  const features = [
    { icon: Server, title: "Write Authorization", desc: "Document updates, file uploads, and task changes are re-authorized on every event — not just at connection time." },
    { icon: Shield, title: "Short-Lived Tokens", desc: "Socket tokens are short-lived and single-purpose, limiting exposure if intercepted. Connection requires fresh authentication." },
    { icon: Globe, title: "Signed Broadcasts", desc: "Inter-service communication is signed and replay-protected so messages cannot be forged or re-sent by an intermediary." },
  ];

  return (
    <section className="py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Per-Event WebSocket Authorization</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Real-time collaboration doesn&#39;t mean relaxed security. Every write operation
              is authorized in real-time.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="rounded-xl border border-border bg-card p-6">
                <f.icon className="h-8 w-8 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function RateLimitingSection() {
  const protections = [
    { title: "Login protection", desc: "Per-IP and per-email sliding-window limits throttle credential stuffing" },
    { title: "Account lockout", desc: "Accounts facing repeated failed authentication are temporarily locked, regardless of source IP" },
    { title: "Signup throttling", desc: "Per-IP limits on signup prevent automated account creation" },
  ];

  const whyDbBacked = [
    { icon: Activity, title: "Persists across restarts", desc: "Lockout state isn't lost when servers restart" },
    { icon: ShieldCheck, title: "Works across IPs", desc: "Attackers can't bypass by changing IP addresses" },
    { icon: Timer, title: "Automatic unlock", desc: "Lockout expires on its own — no manual intervention needed" },
  ];

  return (
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
                {protections.map((p) => (
                  <li key={p.title} className="flex items-start gap-3">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 flex-shrink-0 mt-0.5">
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <span className="font-medium">{p.title}</span>
                      <p className="text-sm text-muted-foreground">{p.desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-border bg-card p-8">
              <h3 className="font-semibold mb-6">Why Database-Backed Lockout?</h3>
              <div className="space-y-4 text-sm">
                {whyDbBacked.map((item) => (
                  <div key={item.title} className="flex items-start gap-3">
                    <item.icon className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-medium">{item.title}</span>
                      <p className="text-muted-foreground">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function AuthenticationSection() {
  return (
    <section className="py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Authentication</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Passwordless by design: passkeys and magic links, with Google and Apple OAuth.
              There&#39;s no password to phish, guess, or leak.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            <FeatureCard
              icon={Lock}
              title="Passwordless Email"
              description="Secure magic link authentication with single-use tokens and rate-limited delivery."
              items={["Single-use tokens — consumed on open", "Short-lived, timing-safe verification", "Per-email and per-IP rate limiting"]}
              small
            />
            <FeatureCard
              icon={Globe}
              title="OAuth (Google & Apple)"
              description="Industry-standard OAuth flows with signed state and strict redirect validation. Google uses RFC 7636 PKCE; Apple relies on ID-token signature validation."
              items={["Signed state parameters on every flow", "Authorization code flow only — no implicit grant", "Google: RFC 7636 PKCE — intercepted codes alone are useless", "Apple: ID-token signature validation on every callback"]}
              small
            />
          </div>

          <CSRFCard />
        </div>
      </div>
    </section>
  );
}

export function VerifiableAuditSection() {
  const cards = [
    {
      icon: Fingerprint,
      title: "Chained at write time",
      desc: "Every security event carries the SHA-256 hash of the prior event. Breaking a record in the middle breaks every record after it — tampering is self-evident.",
    },
    {
      icon: Activity,
      title: "Re-verified continuously",
      desc: "A background job re-walks the chain on a schedule and alerts on any mismatch. This isn't a one-time integrity check at write — it's ongoing.",
    },
    {
      icon: Link2Off,
      title: "Halts external delivery on break",
      desc: "Before any batch ships to an external SIEM, the chain is re-verified. If preflight fails, the batch never leaves — nothing compromised reaches downstream tooling dressed as authentic.",
    },
  ];

  return (
    <section className="py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">An audit log you can actually verify</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Most audit logs are write-only. Ours is a hash chain re-verified on a schedule, and re-verified again before any batch is emitted to an external SIEM.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-8">
            {cards.map((c) => (
              <div key={c.title} className="rounded-xl border border-border bg-card p-6">
                <c.icon className="h-8 w-8 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2">{c.title}</h3>
                <p className="text-sm text-muted-foreground">{c.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-sm text-muted-foreground text-center">
            Events covered: authentication, authorization, data access, admin actions, and security signals (rate limits, anomalies, brute-force detection).
          </p>
        </div>
      </div>
    </section>
  );
}

export function PermissionModelSection() {
  return (
    <section className="py-16 md:py-24 bg-muted/30">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Permissions that can&#39;t cascade by accident</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Most document products inherit permissions from parent folders. One wrong drag-and-drop and a personal folder is suddenly visible to the whole team. PageSpace doesn&#39;t inherit.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 mb-6">
            <div className="rounded-2xl border border-border bg-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-6">
                <Share2 className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-xl font-semibold mb-3">What that means</h3>
              <p className="text-muted-foreground">
                Grant access to a folder and the folder page is shared. Every page inside still has its own grant list. No page becomes visible because of where it lives in the tree.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-6">
                <ShieldCheck className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-xl font-semibold mb-3">Why it matters</h3>
              <p className="text-muted-foreground">
                The &quot;I shared one subfolder and accidentally gave away the tree&quot; class of incident can&#39;t happen here. Every shared page was shared on purpose.
              </p>
            </div>
          </div>

          <p className="text-sm text-muted-foreground text-center">
            Drive owners and admins still have full drive access by role — this is no-silent-cascades for end users, not deny-by-default for operators.
          </p>
        </div>
      </div>
    </section>
  );
}

export function InputSafetySection() {
  const cards = [
    {
      icon: FileSearch,
      title: "Uploads classified by content, not extension",
      desc: "The Magika ML classifier inspects the bytes. Windows PE, macOS Mach-O, Linux ELF, Android DEX — all rejected even when renamed to .txt. Same for raw HTML, SVG, and JavaScript, the classic stored-XSS vectors.",
    },
    {
      icon: Globe,
      title: "SSRF protection that defeats DNS rebinding",
      desc: "Server-side URL fetches are checked against loopback, RFC 1918 private ranges, link-local, and cloud metadata endpoints. Every DNS-resolved IP is validated, not just the first — an attacker rebinding a hostname after the initial check still gets rejected.",
    },
    {
      icon: ShieldAlert,
      title: "Path-traversal defense across encodings",
      desc: "Uploads and user-supplied paths are rejected for ../, URL-encoded variants (%2e%2e, double-encoded), null-byte injection, and symlink escape. Real paths are verified, not string-compared.",
    },
  ];

  return (
    <section className="py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">The boring checklist, done seriously</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              The class of bugs that ship as CVEs in open-source workspace tools — uploaded executables renamed to .txt, SSRF to cloud metadata, path-traversal to read the server filesystem. We did the unglamorous work.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {cards.map((c) => (
              <div key={c.title} className="rounded-xl border border-border bg-card p-6">
                <c.icon className="h-8 w-8 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2">{c.title}</h3>
                <p className="text-sm text-muted-foreground">{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SecurityCTA() {
  return (
    <section className="py-16 md:py-24 bg-muted/30">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mx-auto mb-6">
            <Users className="h-8 w-8 text-primary" />
          </div>
          <h2 className="text-3xl font-bold mb-4">Compare our security to anything else you&#39;re evaluating</h2>
          <p className="text-lg text-muted-foreground mb-8">
            Our docs point straight at the code that implements every claim. Read them, grep them, hand them to your security reviewer.
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
  );
}

function FeatureCard({ icon: Icon, title, description, items, small }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  items: string[];
  small?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-6">
        <Icon className="h-6 w-6 text-primary" />
      </div>
      <h3 className="text-xl font-semibold mb-3">{title}</h3>
      <p className="text-muted-foreground mb-6">{description}</p>
      <ul className={`space-y-3 ${small ? "text-sm" : ""}`}>
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CSRFCard() {
  const badges = ["HMAC-SHA256 signed", "Timing-safe validation", "Pre-login protection"];

  return (
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
            {badges.map((badge) => (
              <span key={badge} className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-900/30 px-3 py-1 text-xs font-medium text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-3 w-3" />
                {badge}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
