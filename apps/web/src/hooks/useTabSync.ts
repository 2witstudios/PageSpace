"use client";

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useTabsStore } from '@/stores/useTabsStore';

/**
 * Syncs URL navigation with the browser-style tabs store.
 *
 * Behavior:
 * - If no tabs exist, creates one from the current URL
 * - If tabs exist, updates the active tab's path (navigates within tab)
 * - Does NOT create new tabs on navigation (that's done via Cmd+click or new tab button)
 */
export function useTabSync() {
  const pathname = usePathname();
  const lastSyncedPath = useRef<string | null>(null);

  const rehydrated = useTabsStore((state) => state.rehydrated);
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const createTab = useTabsStore((state) => state.createTab);
  const navigateInActiveTab = useTabsStore((state) => state.navigateInActiveTab);

  useEffect(() => {
    // Wait for store to rehydrate from localStorage
    if (!rehydrated) return;

    // Skip if we already synced this path
    if (lastSyncedPath.current === pathname) return;

    // If no tabs exist, create one from current path
    if (tabs.length === 0) {
      createTab({ path: pathname });
      lastSyncedPath.current = pathname;
      return;
    }

    // Get active tab's current path
    const activeTab = tabs.find(t => t.id === activeTabId);

    // If active tab already at this path, just update sync ref
    if (activeTab?.path === pathname) {
      lastSyncedPath.current = pathname;
      return;
    }

    // Navigate within the active tab
    navigateInActiveTab(pathname);
    lastSyncedPath.current = pathname;
  }, [pathname, rehydrated, tabs, activeTabId, createTab, navigateInActiveTab]);
}
