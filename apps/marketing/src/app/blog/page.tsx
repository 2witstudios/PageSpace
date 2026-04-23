import Link from "next/link";
import Image from "next/image";
import { Calendar, Clock, User, PenLine } from "lucide-react";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata } from "@/lib/metadata";
import { blogPosts as blogPostsRecord, formatDate } from "./[slug]/data";

export const metadata = pageMetadata.blog;

const blogPosts = Object.values(blogPostsRecord);

export default function BlogPage() {
  const featuredPost = blogPosts.find((post) => post.featured);
  const regularPosts = blogPosts.filter((post) => !post.featured);

  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

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

      {/* Featured Post */}
      {featuredPost && (
        <section className="py-12 md:py-16">
          <div className="container mx-auto px-4 md:px-6">
            <Link
              href={`/blog/${featuredPost.slug}`}
              className="group block rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/50 transition-all hover:shadow-lg"
            >
              <div className="flex flex-col lg:flex-row">
                <div className="flex-1 p-8 lg:p-12 flex flex-col justify-center">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
                      Featured
                    </span>
                    <span className="text-sm text-muted-foreground">{featuredPost.category}</span>
                  </div>
                  <h2 className="text-2xl lg:text-3xl font-bold tracking-tight mb-4 group-hover:text-primary transition-colors">
                    {featuredPost.title}
                  </h2>
                  <p className="text-muted-foreground mb-6 text-lg leading-relaxed">
                    {featuredPost.description}
                  </p>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <User className="h-4 w-4" />
                      {featuredPost.author}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="h-4 w-4" />
                      {formatDate(featuredPost.date)}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-4 w-4" />
                      {featuredPost.readTime}
                    </div>
                  </div>
                </div>
                <div className="lg:w-[420px] h-64 lg:h-auto bg-gradient-to-br from-primary/10 via-primary/5 to-transparent flex items-center justify-center shrink-0">
                  {featuredPost.image ? (
                    <Image
                      src={featuredPost.image}
                      alt={featuredPost.title}
                      width={420}
                      height={280}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-6xl opacity-30 select-none">
                      {featuredPost.category === "Product" ? "🧭" : "📝"}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          </div>
        </section>
      )}

      {/* Blog Posts Grid */}
      <section className="py-12 md:py-16 bg-muted/30">
        <div className="container mx-auto px-4 md:px-6">
          {regularPosts.length > 0 ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {regularPosts.map((post) => (
                <Link
                  key={post.slug}
                  href={`/blog/${post.slug}`}
                  className="group rounded-xl border border-border bg-card overflow-hidden hover:border-primary/50 hover:shadow-lg transition-all"
                >
                  <div className="h-48 bg-gradient-to-br from-muted to-background overflow-hidden">
                    {post.image ? (
                      <Image
                        src={post.image}
                        alt={post.title}
                        width={600}
                        height={300}
                        className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="text-4xl opacity-20 select-none">
                          {post.category === "Guide" ? "📖" : post.category === "Product" ? "🧭" : "🔧"}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-6">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                      {post.category}
                    </span>
                    <h3 className="text-lg font-semibold mt-3 mb-3 group-hover:text-primary transition-colors line-clamp-2">
                      {post.title}
                    </h3>
                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2 leading-relaxed">
                      {post.description}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{formatDate(post.date)}</span>
                      <span>&middot;</span>
                      <span>{post.readTime}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                <PenLine className="h-7 w-7 text-primary" />
              </div>
              <p className="text-lg font-medium mb-1">More posts coming soon</p>
              <p className="text-sm text-muted-foreground">
                We&#39;re working on new guides, deep dives, and product updates.
              </p>
            </div>
          )}
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
