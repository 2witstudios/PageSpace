'use client';

import { useCallback, useMemo } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { PageType } from '@pagespace/lib/client-safe';
import { usePageTree, TreePage } from './usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';

export interface PageRefreshConfig {
  /** Whether pull-to-refresh is available for this page */
  canRefresh: boolean;
  /** The refresh function to call */
  refresh: () => Promise<void>;
  /** Reason why refresh is disabled (for debugging/UI hints) */
  disabledReason?: string;
}

/**
 * Hook to determine the appropriate refresh action for the current page.
 * Returns configuration for pull-to-refresh based on page type.
 */
export function usePageRefresh(): PageRefreshConfig {
  const params = useParams();
  const pathname = usePathname();
  const driveId = params.driveId as string | undefined;
  const pageId = params.pageId as string | undefined;

  const { tree, mutate } = usePageTree(driveId);

  // Find the current page in the tree
  const currentPage = useMemo<TreePage | null>(() => {
    if (!pageId || !tree) return null;
    const result = findNodeAndParent(tree, pageId);
    return result?.node ?? null;
  }, [pageId, tree]);

  // Create a stable refresh function for the page tree
  const refreshTree = useCallback(async () => {
    // Force revalidation of the page tree
    await mutate();
  }, [mutate]);

  // Create a stable no-op function
  const noOp = useCallback(async () => {}, []);

  // Determine refresh configuration based on page type and route
  const config = useMemo<PageRefreshConfig>(() => {
    // Settings pages - can refresh settings data
    if (pathname.endsWith('/settings') || pathname.endsWith('/settings/mcp')) {
      return {
        canRefresh: true,
        refresh: refreshTree,
      };
    }

    // No page selected - can't refresh
    if (!currentPage) {
      return {
        canRefresh: false,
        refresh: noOp,
        disabledReason: 'No page selected',
      };
    }

    const pageType = currentPage.type;

    // Folder pages - refresh the page tree to get updated children
    if (pageType === PageType.FOLDER) {
      return {
        canRefresh: true,
        refresh: refreshTree,
      };
    }

    // Task list pages - refresh the tree (tasks are fetched within the component)
    if (pageType === PageType.TASK_LIST) {
      return {
        canRefresh: true,
        refresh: refreshTree,
      };
    }

    // Document pages - disabled (user is editing)
    if (pageType === PageType.DOCUMENT) {
      return {
        canRefresh: false,
        refresh: noOp,
        disabledReason: 'Editing content',
      };
    }

    // Sheet pages - disabled (user is editing)
    if (pageType === PageType.SHEET) {
      return {
        canRefresh: false,
        refresh: noOp,
        disabledReason: 'Editing content',
      };
    }

    // Canvas pages - disabled (user is editing)
    if (pageType === PageType.CANVAS) {
      return {
        canRefresh: false,
        refresh: noOp,
        disabledReason: 'Editing content',
      };
    }

    // AI Chat and Channel pages - these have their own scroll and use pull-up
    // The pull-down from CenterPanel won't trigger for these (they fill the container)
    if (pageType === PageType.AI_CHAT || pageType === PageType.CHANNEL) {
      return {
        canRefresh: false,
        refresh: noOp,
        disabledReason: 'Uses pull-up refresh instead',
      };
    }

    // File pages - can refresh metadata
    if (pageType === PageType.FILE) {
      return {
        canRefresh: true,
        refresh: refreshTree,
      };
    }

    // Default: allow refresh with tree revalidation
    return {
      canRefresh: true,
      refresh: refreshTree,
    };
  }, [currentPage, pathname, refreshTree, noOp]);

  return config;
}
