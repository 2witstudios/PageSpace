'use client';

import React, { memo, useState, useMemo, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, FolderTree, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType, isFolderPage } from '@pagespace/lib/client-safe';

interface TreeItem {
  path: string;
  title: string;
  type: string;
  pageId?: string;
  children: TreeItem[];
}

interface PageTreeRendererProps {
  /** Tree structure to render */
  tree: TreeItem[];
  /** Drive name for header display */
  driveName?: string;
  /** Drive ID for navigation */
  driveId?: string;
  /** Title override for header */
  title?: string;
  /** Maximum height before scrolling */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

interface TreeNodeProps {
  item: TreeItem;
  depth: number;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  driveId?: string;
}

const TreeNode: React.FC<TreeNodeProps> = memo(function TreeNode({
  item,
  depth,
  expandedIds,
  onToggle,
  driveId
}) {
  const router = useRouter();
  const hasChildren = item.children && item.children.length > 0;
  const isExpanded = expandedIds.has(item.path);
  const isFolder = isFolderPage(item.type as PageType);
  const canNavigate = item.pageId && driveId;

  const handleRowClick = () => {
    // For folders with children: toggle expansion
    // For navigable items: navigate to page
    if (hasChildren && isFolder) {
      onToggle(item.path);
    } else if (canNavigate) {
      router.push(`/dashboard/${driveId}/${item.pageId}`);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "group flex items-center py-1.5 px-1 rounded-md transition-colors",
          "hover:bg-muted/50",
          (canNavigate || hasChildren) && "cursor-pointer"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleRowClick}
      >
        {/* Expand/Collapse chevron */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(item.path);
            }}
            className="p-0.5 rounded hover:bg-muted transition-colors mr-1"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                isExpanded && "rotate-90"
              )}
            />
          </button>
        ) : (
          <div className="w-4 mr-1" />
        )}

        {/* Page type icon */}
        <PageTypeIcon
          type={item.type as PageType}
          className={cn(
            "h-4 w-4 shrink-0",
            isFolder ? "text-primary" : "text-muted-foreground"
          )}
        />

        {/* Title */}
        <span className="ml-2 text-sm truncate text-foreground">
          {item.title}
        </span>

        {/* Navigate hint on hover - only for navigable non-folder items */}
        {canNavigate && !isFolder && (
          <ExternalLink className="h-3 w-3 ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        )}
      </div>

      {/* Render children if expanded */}
      {hasChildren && isExpanded && (
        <div>
          {item.children.map((child, index) => (
            <TreeNode
              key={child.path || index}
              item={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              onToggle={onToggle}
              driveId={driveId}
            />
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * PageTreeRenderer - Renders page tree matching the sidebar style
 *
 * Features:
 * - Expandable/collapsible folders
 * - Page type icons matching the app
 * - Click to navigate to pages
 * - Clean, minimal design without emojis
 */
export const PageTreeRenderer: React.FC<PageTreeRendererProps> = memo(function PageTreeRenderer({
  tree,
  driveName,
  driveId,
  title,
  maxHeight = 350,
  className
}) {
  // Helper to collect all folder IDs for expansion
  const collectFolderIds = useCallback((items: TreeItem[]): Set<string> => {
    const ids = new Set<string>();
    const traverse = (nodes: TreeItem[]) => {
      for (const item of nodes) {
        if (item.children?.length > 0) {
          ids.add(item.path);
          traverse(item.children);
        }
      }
    };
    traverse(items);
    return ids;
  }, []);

  // Start with all folders expanded for visibility
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => collectFolderIds(tree));

  // Reset expandedIds when tree prop changes
  useEffect(() => {
    setExpandedIds(collectFolderIds(tree));
  }, [tree, collectFolderIds]);

  const handleToggle = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Count total pages
  const pageCount = useMemo(() => {
    let count = 0;
    const countPages = (items: TreeItem[]) => {
      for (const item of items) {
        count++;
        if (item.children?.length) {
          countPages(item.children);
        }
      }
    };
    countPages(tree);
    return count;
  }, [tree]);

  const displayTitle = title || (driveName ? `Pages in ${driveName}` : 'Page Structure');

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          <FolderTree className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{displayTitle}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {pageCount} {pageCount === 1 ? 'page' : 'pages'}
        </span>
      </div>

      {/* Tree content */}
      <div
        className="bg-background overflow-auto p-2"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {tree.length > 0 ? (
          tree.map((item, index) => (
            <TreeNode
              key={item.path || index}
              item={item}
              depth={0}
              expandedIds={expandedIds}
              onToggle={handleToggle}
              driveId={driveId}
            />
          ))
        ) : (
          <div className="text-sm text-muted-foreground text-center py-4">
            No pages found
          </div>
        )}
      </div>
    </div>
  );
});
