import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { ArrowLeft, Calendar, Clock, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { blogPosts } from "./data";
import { ShareButtons } from "./ShareButtons";
import { APP_URL } from "@/lib/metadata";

const SITE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://pagespace.ai";

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
      url: `${SITE_URL}/blog/${slug}`,
      publishedTime: post.date,
      authors: [post.author],
      ...(post.image && { images: [{ url: `${SITE_URL}${post.image}` }] }),
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
            <header className="mb-10">
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary mb-4">
                {post.category}
              </span>
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight leading-[1.15] mb-6">
                {post.title}
              </h1>
              <p className="text-lg text-muted-foreground mb-6">
                {post.description}
              </p>
              <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground pb-8 border-b border-border">
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

            {/* Feature Image */}
            {post.image ? (
              <div className="rounded-2xl overflow-hidden mb-12">
                <Image
                  src={post.image}
                  alt={post.title}
                  width={1200}
                  height={630}
                  className="w-full h-auto"
                  priority
                />
              </div>
            ) : (
              <div className="rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent h-64 md:h-72 mb-12" />
            )}

            {/* Content */}
            <div className="prose prose-lg prose-neutral dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-h2:text-2xl prose-h2:mt-12 prose-h2:mb-4 prose-p:leading-relaxed prose-p:text-muted-foreground prose-li:text-muted-foreground prose-strong:text-foreground prose-strong:font-semibold prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:text-sm prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:before:content-none prose-code:after:content-none prose-pre:bg-muted/60 prose-pre:text-foreground prose-pre:border prose-pre:border-border/50 prose-pre:rounded-xl prose-pre:[&_code]:bg-transparent prose-blockquote:border-l-primary/50 prose-blockquote:text-muted-foreground prose-hr:border-border">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {post.content}
              </ReactMarkdown>
            </div>

            {/* Share */}
            <div className="mt-16 pt-8 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Share this article</span>
                <ShareButtons title={post.title} />
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
              <a href={`${APP_URL}/auth/signup`} rel="noopener">
                Get Started Free
              </a>
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
