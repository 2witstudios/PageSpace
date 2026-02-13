import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles, ArrowLeft, Calendar, Clock, User, Share2, Twitter, Linkedin } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Metadata } from "next";

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
            <Link href="/blog" className="text-sm font-medium text-foreground transition-colors">
              Blog
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
              <Link href="/login">Log in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/signup">Get Started</Link>
            </Button>
          </div>
        </div>
      </header>

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
              {post.content.split('\n').map((paragraph, i) => {
                if (paragraph.startsWith('## ')) {
                  return <h2 key={i} className="text-2xl font-bold mt-8 mb-4">{paragraph.replace('## ', '')}</h2>;
                }
                if (paragraph.startsWith('### ')) {
                  return <h3 key={i} className="text-xl font-semibold mt-6 mb-3">{paragraph.replace('### ', '')}</h3>;
                }
                if (paragraph.startsWith('- ')) {
                  return <li key={i} className="ml-4">{paragraph.replace('- ', '')}</li>;
                }
                if (paragraph.startsWith('```')) {
                  return null;
                }
                if (paragraph.trim().startsWith('📁') || paragraph.trim().startsWith('├') || paragraph.trim().startsWith('│') || paragraph.trim().startsWith('└') || paragraph.trim().startsWith('🤖') || paragraph.trim().startsWith('📄')) {
                  return <pre key={i} className="bg-muted p-4 rounded-lg font-mono text-sm my-4 overflow-x-auto">{paragraph}</pre>;
                }
                if (paragraph.match(/^\d+\./)) {
                  return <li key={i} className="ml-4 list-decimal">{paragraph.replace(/^\d+\.\s*/, '')}</li>;
                }
                if (paragraph.trim()) {
                  return <p key={i} className="mb-4 text-muted-foreground leading-relaxed">{paragraph}</p>;
                }
                return null;
              })}
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
              <Link href="/signup">
                Get Started Free
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-12">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                <Sparkles className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="font-semibold">PageSpace</span>
            </div>
            <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
              <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
              <Link href="/downloads" className="hover:text-foreground transition-colors">Downloads</Link>
              <Link href="/docs" className="hover:text-foreground transition-colors">Docs</Link>
              <Link href="/changelog" className="hover:text-foreground transition-colors">Changelog</Link>
            </nav>
            <p className="text-sm text-muted-foreground">
              &copy; {new Date().getFullYear()} PageSpace. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
