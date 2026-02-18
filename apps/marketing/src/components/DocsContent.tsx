"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, ArrowLeft, ArrowRight } from "lucide-react";
import { getNavContext, getBreadcrumbs } from "@/app/docs/docs-nav";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface DocsContentProps {
  children: React.ReactNode;
}

function Breadcrumbs({ pathname }: { pathname: string }) {
  const crumbs = getBreadcrumbs(pathname);

  return (
    <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-6">
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5" />}
          {i === crumbs.length - 1 ? (
            <span className="text-foreground font-medium">{crumb.title}</span>
          ) : (
            <Link href={crumb.href} className="hover:text-foreground transition-colors">
              {crumb.title}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

function PrevNext({ pathname }: { pathname: string }) {
  const { prev, next } = getNavContext(pathname);

  if (!prev && !next) return null;

  return (
    <div className="mt-16 flex items-stretch gap-4 border-t border-border pt-8">
      {prev ? (
        <Link
          href={prev.href}
          className="flex-1 group rounded-xl border border-border p-4 hover:border-primary/50 transition-colors"
        >
          <span className="text-xs text-muted-foreground">Previous</span>
          <span className="mt-1 flex items-center gap-2 font-medium group-hover:text-primary transition-colors">
            <ArrowLeft className="h-4 w-4" />
            {prev.title}
          </span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
      {next ? (
        <Link
          href={next.href}
          className="flex-1 group rounded-xl border border-border p-4 hover:border-primary/50 transition-colors text-right"
        >
          <span className="text-xs text-muted-foreground">Next</span>
          <span className="mt-1 flex items-center justify-end gap-2 font-medium group-hover:text-primary transition-colors">
            {next.title}
            <ArrowRight className="h-4 w-4" />
          </span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

export function DocsContent({ children }: DocsContentProps) {
  const pathname = usePathname();

  return (
    <div className="flex-1 min-w-0 max-w-4xl pb-16">
      <Breadcrumbs pathname={pathname} />
      {children}
      <PrevNext pathname={pathname} />
    </div>
  );
}

export function DocsMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4 prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3 prose-p:leading-relaxed prose-p:text-muted-foreground prose-li:text-muted-foreground prose-strong:text-foreground prose-strong:font-semibold prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:text-sm prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:before:content-none prose-code:after:content-none prose-pre:bg-muted/60 prose-pre:text-foreground prose-pre:border prose-pre:border-border/50 prose-pre:rounded-xl prose-pre:[&_code]:bg-transparent prose-blockquote:border-l-primary/50 prose-blockquote:text-muted-foreground prose-hr:border-border prose-table:text-sm prose-th:text-left prose-th:font-semibold prose-th:border-b prose-th:border-border prose-th:pb-2 prose-td:border-b prose-td:border-border/50 prose-td:py-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
