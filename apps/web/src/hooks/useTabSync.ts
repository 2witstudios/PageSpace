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

  useEffect(() => {
    // Wait for store to rehydrate from localStorage
    if (!rehydrated) return;

    // Skip if we already synced this path
    if (lastSyncedPath.current === pathname) return;

    const state = useTabsStore.getState();

    // If no tabs exist, create one from current path
    if (state.tabs.length === 0) {
      state.createTab({ path: pathname });
      lastSyncedPath.current = pathname;
      return;
    }

    // Get active tab's current path
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

    // If active tab already at this path, just update sync ref
    if (activeTab?.path === pathname) {
      lastSyncedPath.current = pathname;
      return;
    }

    // Navigate within the active tab
    state.navigateInActiveTab(pathname);
    lastSyncedPath.current = pathname;
  }, [pathname, rehydrated]);
}
