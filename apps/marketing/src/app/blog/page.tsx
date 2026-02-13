import Link from "next/link";
import { Sparkles, Calendar, Clock, User, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.blog;

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  author: string;
  date: string;
  readTime: string;
  category: string;
  featured?: boolean;
}

const blogPosts: BlogPost[] = [
  {
    slug: "introducing-pagespace",
    title: "Introducing PageSpace: AI-Native Collaboration",
    description: "Today we're launching PageSpace, a new kind of workspace where AI isn't bolted on—it's woven into every interaction. Here's our vision for the future of work.",
    author: "PageSpace Team",
    date: "2026-02-10",
    readTime: "5 min read",
    category: "Announcements",
    featured: true,
  },
  {
    slug: "understanding-page-agents",
    title: "Understanding Page Agents: AI That Lives in Your Workspace",
    description: "Learn how PageSpace's unique Page Agent architecture gives you specialized AI helpers that understand your project context.",
    author: "PageSpace Team",
    date: "2026-02-08",
    readTime: "7 min read",
    category: "Product",
  },
  {
    slug: "mcp-servers-explained",
    title: "MCP Servers Explained: Connecting AI to Your Tools",
    description: "A deep dive into Model Context Protocol and how PageSpace uses it to give AI direct access to your tools and data.",
    author: "PageSpace Team",
    date: "2026-02-05",
    readTime: "8 min read",
    category: "Technical",
  },
  {
    slug: "ai-rollback-why-it-matters",
    title: "AI Rollback: Why One-Click Undo Changes Everything",
    description: "How PageSpace's version control for AI edits gives you confidence to experiment without fear of losing work.",
    author: "PageSpace Team",
    date: "2026-02-01",
    readTime: "4 min read",
    category: "Product",
  },
];

const categories = ["All", "Announcements", "Product", "Technical", "Company"];

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function BlogPage() {
  const featuredPost = blogPosts.find((post) => post.featured);
  const regularPosts = blogPosts.filter((post) => !post.featured);

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

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Blog
            </h1>
            <p className="text-lg text-muted-foreground">
              Product updates, technical deep dives, and thoughts on the future of AI-native collaboration.
            </p>
          </div>
        </div>
      </section>

      {/* Category Filter */}
      <section className="border-b border-border">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex items-center gap-4 overflow-x-auto pb-4 -mb-px">
            {categories.map((category) => (
              <button
                key={category}
                className={`px-4 py-2 text-sm font-medium whitespace-nowrap rounded-full transition-colors ${
                  category === "All"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Post */}
      {featuredPost && (
        <section className="py-12 md:py-16">
          <div className="container mx-auto px-4 md:px-6">
            <Link
              href={`/blog/${featuredPost.slug}`}
              className="group block rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/50 transition-colors"
            >
              <div className="flex flex-col lg:flex-row">
                <div className="flex-1 p-8 lg:p-12">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
                      Featured
                    </span>
                    <span className="text-sm text-muted-foreground">{featuredPost.category}</span>
                  </div>
                  <h2 className="text-2xl lg:text-3xl font-bold mb-4 group-hover:text-primary transition-colors">
                    {featuredPost.title}
                  </h2>
                  <p className="text-muted-foreground mb-6 text-lg">
                    {featuredPost.description}
                  </p>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <User className="h-4 w-4" />
                      {featuredPost.author}
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      {formatDate(featuredPost.date)}
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      {featuredPost.readTime}
                    </div>
                  </div>
                </div>
                <div className="lg:w-96 h-64 lg:h-auto bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10">
                    <Sparkles className="h-10 w-10 text-primary" />
                  </div>
                </div>
              </div>
            </Link>
          </div>
        </section>
      )}

      {/* Blog Posts Grid */}
      <section className="py-12 md:py-16 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {regularPosts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group rounded-xl border border-border bg-card overflow-hidden hover:border-primary/50 hover:shadow-lg transition-all"
              >
                <div className="h-40 bg-gradient-to-br from-muted to-background flex items-center justify-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                </div>
                <div className="p-6">
                  <span className="text-xs font-medium text-muted-foreground">{post.category}</span>
                  <h3 className="text-lg font-semibold mt-2 mb-3 group-hover:text-primary transition-colors line-clamp-2">
                    {post.title}
                  </h3>
                  <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                    {post.description}
                  </p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{formatDate(post.date)}</span>
                    <span>•</span>
                    <span>{post.readTime}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Newsletter CTA */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold mb-4">Stay updated</h2>
            <p className="text-muted-foreground mb-6">
              Get the latest product updates and insights delivered to your inbox.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
              <input
                type="email"
                placeholder="Enter your email"
                className="flex-1 rounded-lg border border-border bg-background px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <Button>
                Subscribe
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              No spam. Unsubscribe anytime.
            </p>
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
