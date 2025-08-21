"use client";

import { useBreadcrumbs } from "@/hooks/useBreadcrumbs";
import { usePageStore } from "@/hooks/usePage";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useMobile } from "@/hooks/use-mobile";

export function Breadcrumbs() {
  const pageId = usePageStore((state) => state.pageId);
  const { breadcrumbs, isLoading } = useBreadcrumbs(pageId || null);
  const isMobile = useMobile();

  if (isLoading) {
    return <div className="h-6 w-1/2 bg-muted animate-pulse rounded-md" />;
  }

  if (!breadcrumbs || breadcrumbs.length <= 1) {
    return null;
  }

  const displayPath = isMobile && breadcrumbs.length > 2
    ? [breadcrumbs[0], { title: '...', id: 'ellipsis' }, breadcrumbs[breadcrumbs.length - 1]]
    : breadcrumbs;

  return (
    <nav className="flex items-center text-sm text-muted-foreground">
      {displayPath.map((crumb, index) => (
        <div key={crumb.id} className="flex items-center">
          {index > 0 && <ChevronRight className="h-4 w-4 mx-1" />}
          {'drive' in crumb && crumb.drive ? (
            <Link
              href={`/dashboard/${crumb.drive.slug}/${crumb.id}`}
              className="hover:underline"
            >
              {crumb.title}
            </Link>
          ) : (
            <span>{crumb.title}</span>
          )}
        </div>
      ))}
    </nav>
  );
}