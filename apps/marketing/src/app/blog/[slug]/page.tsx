import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles, ArrowLeft, Calendar, Clock, User, Share2, Twitter, Linkedin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  content: string;
  author: string;
  date: string;
  readTime: string;
  category: string;
}

const blogPosts: Record<string, BlogPost> = {
  "security-architecture-deep-dive": {
    slug: "security-architecture-deep-dive",
    title: "How PageSpace Protects Your Data",
    description: "A deep dive into PageSpace's security architecture: opaque session tokens, per-event WebSocket authorization, and defense-in-depth design.",
    content: `
## Security by Design

At PageSpace, security isn't an afterthought—it's foundational to everything we build. Here's how we protect your data at every layer.

## Opaque Session Tokens

Unlike systems that use JWTs (which can be decoded by anyone), PageSpace uses opaque session tokens:

- **Hash-only storage**: We never store your actual token—only a SHA-256 hash
- **High entropy**: 256 bits of randomness makes tokens unguessable
- **Stateful validation**: Every request is verified against our database
- **Instant revocation**: Compromised sessions can be invalidated immediately

### Why Not JWT?

JWTs are popular, but they have downsides for stateful applications:

- Can't be revoked until they expire
- Carry claims that anyone can read
- Require careful implementation to avoid vulnerabilities

Our opaque tokens give us full control over session lifecycle.

## Account Protection

### Rate Limiting

Distributed rate limiting protects against brute force:

- **Login attempts**: 5 per 15 minutes per IP and per email
- **Signup**: 3 per hour to prevent abuse
- **Password reset**: 3 per hour per account

### Account Lockout

After 10 failed login attempts:

- Account locked for 15 minutes
- Persists across IP changes (database-backed, not in-memory)
- Automatic unlock after cooldown period

### Password Requirements

Strong password policy enforced:

- Minimum 12 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- Hashed with bcrypt (cost factor 12)

## CSRF Protection

Every state-changing request requires CSRF validation:

- **Signed tokens**: HMAC-SHA256 prevents tampering
- **Timing-safe comparison**: Immune to timing attacks
- **Pre-login protection**: Even login forms are protected

## Defense in Depth

No single security measure is perfect, so we layer them:

1. **Transport security**: TLS encryption for all connections
2. **Authentication**: Session tokens with database validation
3. **Authorization**: Per-resource permission checks
4. **Rate limiting**: Distributed throttling
5. **Monitoring**: Security event logging for audit trails

Security is a continuous process, not a checklist.
    `,
    author: "PageSpace Team",
    date: "2026-02-14",
    readTime: "8 min read",
    category: "Security",
  },
  "real-time-security": {
    slug: "real-time-security",
    title: "Securing Real-Time Collaboration",
    description: "How PageSpace implements per-event authorization for WebSocket connections, ensuring every action is verified in real-time.",
    content: `
## The Challenge of Real-Time Security

Real-time collaboration requires persistent WebSocket connections. But how do you ensure security when connections stay open for extended periods?

## Per-Event Authorization

PageSpace doesn't just authenticate the connection—we authorize every event:

### Sensitive Events (Re-Authorized)

Every write operation is verified in real-time:

- Document updates and page changes
- File uploads
- Comment creation and deletion
- Task management operations

### Read-Only Events (Connection Auth)

Lower-risk events use connection-level auth:

- Cursor movement
- Presence updates
- Typing indicators
- Selection changes

## Socket Token Flow

WebSocket auth uses a short-lived token exchange:

1. Browser requests a socket token (same-origin, with cookies)
2. Server validates the session and issues a 5-minute socket token
3. Client connects to WebSocket with the socket token
4. Server validates and establishes the connection

### Why Short-Lived Tokens?

Socket tokens expire in 5 minutes because:

- Limits exposure if token is intercepted
- Forces re-authentication for long sessions
- Separate auth domain from main sessions

## Inter-Service Security

Our real-time service communicates with the main app securely:

- **HMAC-signed broadcasts**: Services verify each other's identity
- **Timestamp validation**: Prevents replay attacks
- **Event-specific signatures**: Each broadcast type is authenticated

## Permission-Aware Broadcasting

When events are broadcast:

- User permissions are checked in real-time
- Unauthorized users don't receive events they shouldn't see
- Permission changes take effect immediately

Real-time doesn't mean less secure—it means security has to be real-time too.
    `,
    author: "PageSpace Team",
    date: "2026-02-13",
    readTime: "6 min read",
    category: "Technical",
  },
  "oauth-security-best-practices": {
    slug: "oauth-security-best-practices",
    title: "OAuth Security: Signed State and Safe Redirects",
    description: "How PageSpace implements secure OAuth flows with HMAC-signed state parameters and strict redirect validation.",
    content: `
## OAuth Done Right

OAuth is powerful but tricky to implement securely. Here's how PageSpace handles it.

## The State Parameter Problem

The OAuth state parameter prevents CSRF attacks, but many implementations are weak:

- Random string that's easy to forge
- No validation of tampering
- Return URL stored in plain text

### Our Approach: Signed State

PageSpace uses HMAC-SHA256 signed state parameters:

\`\`\`
state = base64({
  returnUrl: "/dashboard",
  platform: "web",
  signature: HMAC(secret, data)
})
\`\`\`

Benefits:

- **Tamper-proof**: Any modification breaks the signature
- **Authenticated**: Only our server can create valid states
- **Contextual**: Contains metadata for better UX

## Safe Redirect Validation

Open redirect vulnerabilities are common in OAuth. We prevent them:

### Strict URL Validation

Return URLs must be:

- Relative paths starting with \`/\`
- No protocol-relative URLs (\`//evil.com\`)
- No backslash tricks (\`\\/evil.com\`)
- No encoded sequences that bypass validation

### Example Blocked URLs

These would all be rejected:

- \`https://evil.com\`
- \`//evil.com\`
- \`\\/evil.com\`
- \`/\\evil.com\`

## Supported Providers

PageSpace supports OAuth with:

- **Google**: Full profile and email access
- **Apple**: Privacy-focused sign-in

Both use authorization code flow (never implicit flow) for maximum security.

## Token Handling

After successful OAuth:

1. Exchange code for tokens server-side
2. Validate token integrity
3. Create our own session token
4. Never expose OAuth tokens to the browser

OAuth is complex, but getting it right matters.
    `,
    author: "PageSpace Team",
    date: "2026-02-12",
    readTime: "5 min read",
    category: "Technical",
  },
  "introducing-pagespace": {
    slug: "introducing-pagespace",
    title: "Introducing PageSpace: AI-Native Collaboration",
    description: "Today we're launching PageSpace, a new kind of workspace where AI isn't bolted on—it's woven into every interaction.",
    content: `
## A New Vision for Work

For too long, AI has been an afterthought in productivity tools—a chatbot in a sidebar, a feature you opt into. We built PageSpace because we believe AI should be fundamentally woven into how you work.

### The Problem with Bolt-on AI

Most productivity tools treat AI as an add-on. You write a document, then ask AI to review it. You have a conversation, then summarize it with AI. The AI doesn't know your context, your project, or your team.

### Our Approach: AI-Native Architecture

PageSpace is built differently. Every workspace has AI at its core:

- **Global Assistant**: Your personal AI that follows you across all workspaces
- **Page Agents**: Specialized AI helpers that live in your file tree with custom prompts
- **Context-Aware**: AI understands your project hierarchy and team dynamics

### What You Can Do Today

With PageSpace, you can:

1. **Write with AI inline** - Get suggestions and completions as you type
2. **Collaborate in channels** - @mention AI agents in any conversation
3. **Assign tasks to AI** - Let AI work autonomously on research and drafting
4. **Roll back any AI change** - One-click undo for all AI edits

### Join Us

We're just getting started. Sign up today and help shape the future of AI-native collaboration.
    `,
    author: "PageSpace Team",
    date: "2026-02-10",
    readTime: "5 min read",
    category: "Announcements",
  },
  "understanding-page-agents": {
    slug: "understanding-page-agents",
    title: "Understanding Page Agents: AI That Lives in Your Workspace",
    description: "Learn how PageSpace's unique Page Agent architecture gives you specialized AI helpers that understand your project context.",
    content: `
## What Are Page Agents?

Page Agents are a core innovation in PageSpace. Unlike traditional AI assistants that exist in isolation, Page Agents live directly in your file tree—right alongside your documents, tasks, and notes.

### The File Tree as AI Context

When you create a Page Agent, it inherits context from its location:

\`\`\`
📁 My Workspace
├── 📄 Project Overview
├── 🤖 Marketing AI (Page Agent)
│   └── Custom prompt: "You are a marketing expert..."
├── 📁 Campaigns
│   ├── 📄 Q1 Campaign
│   └── 📄 Q2 Campaign
\`\`\`

The Marketing AI agent automatically understands:
- It's part of "My Workspace"
- The project context from "Project Overview"
- The campaigns it should help with

### Custom Prompts

Each Page Agent can have a custom system prompt. This lets you create specialized helpers:

- **Code Review AI**: Strict code review with your team's standards
- **Writing Assistant**: Matches your brand voice and style
- **Research Agent**: Focuses on specific domains or sources

### Nested Context

Page Agents can be nested, creating hierarchies of context:

\`\`\`
📁 Engineering
├── 🤖 Engineering AI (broad technical knowledge)
│   └── 📁 Frontend
│       └── 🤖 React Expert (React-specific knowledge)
\`\`\`

The React Expert inherits context from both the Engineering workspace and its parent agent.

### Try It Today

Page Agents are available on all PageSpace plans. Create your first one in minutes.
    `,
    author: "PageSpace Team",
    date: "2026-02-08",
    readTime: "7 min read",
    category: "Product",
  },
  "mcp-servers-explained": {
    slug: "mcp-servers-explained",
    title: "MCP Servers Explained: Connecting AI to Your Tools",
    description: "A deep dive into Model Context Protocol and how PageSpace uses it to give AI direct access to your tools and data.",
    content: `
## What is MCP?

Model Context Protocol (MCP) is an open protocol that allows AI models to safely interact with external systems. Instead of copy-pasting data into chat, AI can directly access databases, file systems, and APIs.

### Why MCP Matters

Traditional AI assistants are limited to what you tell them. With MCP:

- AI can query your database directly
- AI can read and write files
- AI can interact with external services
- All with proper permissions and safety

### How PageSpace Uses MCP

PageSpace integrates MCP servers to extend what your AI agents can do:

**Available MCP Servers:**
- Filesystem - Read/write local files
- PostgreSQL - Query databases
- GitHub - Manage repositories
- Slack - Send messages
- Google Calendar - Manage events
- Web Search - Research topics

### Setting Up MCP

Adding an MCP server is straightforward:

1. Go to Workspace Settings → Integrations
2. Select the MCP server you want
3. Configure authentication
4. AI agents can now use that server

### Security First

MCP servers in PageSpace are sandboxed:
- Each server has explicit permissions
- Actions are logged and auditable
- You control what AI can access

### Learn More

Visit our [MCP documentation](/docs/mcp) for detailed setup guides.
    `,
    author: "PageSpace Team",
    date: "2026-02-05",
    readTime: "8 min read",
    category: "Technical",
  },
  "ai-rollback-why-it-matters": {
    slug: "ai-rollback-why-it-matters",
    title: "AI Rollback: Why One-Click Undo Changes Everything",
    description: "How PageSpace's version control for AI edits gives you confidence to experiment without fear of losing work.",
    content: `
## The Fear of AI Edits

Have you ever hesitated to let AI edit your document? Worried it might change something important? You're not alone.

The biggest barrier to AI adoption isn't capability—it's trust. Users are afraid of:
- Losing their original work
- AI making unwanted changes
- Not being able to go back

### Introducing AI Rollback

PageSpace solves this with AI Rollback. Every AI edit is versioned, and you can undo it with one click.

### How It Works

1. **Every AI action is tracked**: Edits, suggestions, completions
2. **Changes are grouped logically**: One "undo" reverts one AI action
3. **Full history preserved**: See exactly what AI changed
4. **One-click rollback**: Instantly restore previous state

### In Practice

Imagine you're writing a document:

1. You ask AI to "make this more concise"
2. AI rewrites three paragraphs
3. You don't like paragraph 2
4. Click rollback on just that paragraph
5. Your original is restored

### Beyond Documents

AI Rollback works everywhere in PageSpace:
- Document edits
- Task completions
- Channel messages drafted by AI
- Code changes

### Experiment Freely

With AI Rollback, you can experiment without fear. Try bold AI suggestions knowing you can always go back.

This is how AI collaboration should feel.
    `,
    author: "PageSpace Team",
    date: "2026-02-01",
    readTime: "4 min read",
    category: "Product",
  },
};

export async function generateStaticParams() {
  return Object.keys(blogPosts).map((slug) => ({ slug }));
}

export async function generateMetadata(
  props: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await props.params;
  const post = blogPosts[slug];

  if (!post) {
    return { title: "Post Not Found | PageSpace Blog" };
  }

  return {
    title: `${post.title} | PageSpace Blog`,
    description: post.description,
    openGraph: {
      title: post.title,
      description: post.description,
      type: "article",
      publishedTime: post.date,
      authors: [post.author],
    },
  };
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default async function BlogPostPage(
  props: { params: Promise<{ slug: string }> }
) {
  const { slug } = await props.params;
  const post = blogPosts[slug];

  if (!post) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

      {/* Back Link */}
      <div className="container mx-auto px-4 md:px-6 pt-8">
        <Link
          href="/blog"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Blog
        </Link>
      </div>

      {/* Article */}
      <article className="py-8 md:py-12">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl">
            {/* Header */}
            <header className="mb-8">
              <span className="text-sm font-medium text-primary">{post.category}</span>
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold mt-3 mb-6">
                {post.title}
              </h1>
              <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4" />
                  {post.author}
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  {formatDate(post.date)}
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  {post.readTime}
                </div>
              </div>
            </header>

            {/* Feature Image Placeholder */}
            <div className="rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 h-64 md:h-80 flex items-center justify-center mb-8">
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10">
                <Sparkles className="h-10 w-10 text-primary" />
              </div>
            </div>

            {/* Content */}
            <div className="prose prose-neutral dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {post.content}
              </ReactMarkdown>
            </div>

            {/* Share */}
            <div className="mt-12 pt-8 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Share this article</span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm">
                    <Twitter className="h-4 w-4 mr-2" />
                    Twitter
                  </Button>
                  <Button variant="outline" size="sm">
                    <Linkedin className="h-4 w-4 mr-2" />
                    LinkedIn
                  </Button>
                  <Button variant="outline" size="sm">
                    <Share2 className="h-4 w-4 mr-2" />
                    Copy Link
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>

      {/* CTA */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to try PageSpace?</h2>
            <p className="text-muted-foreground mb-6">
              Start free with generous limits. No credit card required.
            </p>
            <Button size="lg" asChild>
              <a href={`${APP_URL}/auth/signup`}>
                Get Started Free
              </a>
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter variant="compact" />
    </div>
  );
}
