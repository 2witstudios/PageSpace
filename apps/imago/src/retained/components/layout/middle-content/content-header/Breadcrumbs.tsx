"use client";

import { useBreadcrumbs } from "@/retained/hooks/useBreadcrumbs";
import { usePageStore } from "@/retained/hooks/usePage";
import Link from "@/retained-adapters/link";
import { ChevronRight } from "lucide-react";
import { useMobile } from "@/retained/hooks/useMobile";
import { Skeleton } from "@/retained/components/ui/skeleton";

export function Breadcrumbs({ pageId: propPageId }: { pageId?: string | null } = {}) {
  const storePageId = usePageStore((state) => state.pageId);
  const pageId = propPageId !== undefined ? propPageId : storePageId;
  const { breadcrumbs, isLoading } = useBreadcrumbs(pageId || null);
  const isMobile = useMobile();

  if (isLoading) {
    return <Skeleton className="h-6 w-1/2" />;
  }

  if (!breadcrumbs || breadcrumbs.length <= 1) {
    return null;
  }

  const displayPath = isMobile && breadcrumbs.length > 2
    ? [breadcrumbs[0], { title: '...', id: 'ellipsis' }, breadcrumbs[breadcrumbs.length - 1]]
    : breadcrumbs;

  return (
    <nav className="breadcrumb flex items-center text-sm text-muted-foreground">
      {displayPath.map((crumb, index) => (
        <div key={crumb.id} className="flex items-center">
          {index > 0 && <ChevronRight className="h-4 w-4 mx-1" />}
          {'drive' in crumb && crumb.drive ? (
            <Link
              href={`/dashboard/${crumb.drive.id}/${crumb.id}`}
              className="hover:underline truncate max-w-[120px] @[400px]:max-w-[200px]"
              title={crumb.title}
            >
              {crumb.title}
            </Link>
          ) : (
            <span className="truncate max-w-[120px] @[400px]:max-w-[200px]" title={crumb.title}>
              {crumb.title}
            </span>
          )}
        </div>
      ))}
    </nav>
  );
}