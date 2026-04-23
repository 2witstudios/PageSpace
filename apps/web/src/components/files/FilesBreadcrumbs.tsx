'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import type { TreePage } from '@/hooks/usePageTree';

interface FilesBreadcrumbsProps {
  driveId: string;
  driveName: string;
  currentPageId: string | null;
  tree: TreePage[];
}

export function FilesBreadcrumbs({ driveId, driveName, currentPageId, tree }: FilesBreadcrumbsProps) {
  const crumbs = useMemo(() => {
    if (!currentPageId) return [];

    // Walk up the tree via parentId to build ancestor chain
    const ancestors: { id: string; title: string }[] = [];
    let nodeId: string | null = currentPageId;

    while (nodeId) {
      const result = findNodeAndParent(tree, nodeId);
      if (!result) break;
      ancestors.unshift({ id: result.node.id, title: result.node.title });
      nodeId = result.node.parentId ?? null;
    }

    return ancestors;
  }, [currentPageId, tree]);

  const rootHref = `/dashboard/${driveId}/files`;

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground min-w-0 overflow-hidden" aria-label="Breadcrumb">
      {currentPageId ? (
        <Link href={rootHref} className="hover:text-foreground transition-colors">
          {driveName}
        </Link>
      ) : (
        <span className="text-foreground font-medium">{driveName}</span>
      )}

      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5" />
            {isLast ? (
              <span className="text-foreground font-medium truncate">{crumb.title}</span>
            ) : (
              <Link
                href={`${rootHref}/${crumb.id}`}
                className="hover:text-foreground transition-colors"
              >
                {crumb.title}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
