"use client";

import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { useOpenTabsStore, type TabPageType } from '@/stores/useOpenTabsStore';

/**
 * Syncs URL navigation with the tabs store.
 * When a user navigates to a page (via sidebar, URL, or bookmark),
 * this hook ensures a tab is opened for that page.
 */
export function useTabSync() {
  const params = useParams();
  const pageId = params.pageId as string | undefined;
  const driveId = params.driveId as string | undefined;
  const { tree, isLoading } = usePageTree(driveId ?? '');
  const lastSyncedPageId = useRef<string | null>(null);

  const openTab = useOpenTabsStore((state) => state.openTab);
  const setActiveTab = useOpenTabsStore((state) => state.setActiveTab);
  const tabs = useOpenTabsStore((state) => state.tabs);
  const rehydrated = useOpenTabsStore((state) => state.rehydrated);

  useEffect(() => {
    // Wait for store to rehydrate from localStorage
    if (!rehydrated) return;

    // Skip if no page is selected or still loading
    if (!pageId || !driveId || isLoading) return;

    // Skip if we already synced this page
    if (lastSyncedPageId.current === pageId) return;

    // Check if tab already exists
    const existingTab = tabs.find(t => t.id === pageId);

    if (existingTab) {
      // Tab exists, just activate it
      setActiveTab(pageId);
      lastSyncedPageId.current = pageId;
      return;
    }

    // Find page in tree to get its info
    const pageResult = findNodeAndParent(tree, pageId);

    if (!pageResult) {
      // Page not found in tree yet - might still be loading
      // Don't update lastSyncedPageId so we retry when tree loads
      return;
    }

    const { node: page } = pageResult;

    // Open new tab for this page
    openTab({
      id: page.id,
      driveId: driveId,
      title: page.title,
      type: page.type as TabPageType,
    });

    lastSyncedPageId.current = pageId;
  }, [pageId, driveId, tree, isLoading, rehydrated, tabs, openTab, setActiveTab]);
}
