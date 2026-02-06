"use client";

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTabsStore, selectActiveTab } from '@/stores/useTabsStore';

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
  const router = useRouter();
  const lastSyncedPath = useRef<string | null>(null);
  const didAttemptDesktopRestore = useRef(false);

  const rehydrated = useTabsStore((state) => state.rehydrated);

  useEffect(() => {
    // Wait for store to rehydrate from localStorage
    if (!rehydrated) return;

    const state = useTabsStore.getState();
    const hasTabs = state.tabs.length > 0;

    // Heal invalid state: tabs exist but activeTabId is missing/stale.
    if (hasTabs && !selectActiveTab(state)) {
      state.setActiveTab(state.tabs[0].id);
    }

    // Desktop bootstrap: app starts at /dashboard, so restore the active tab route once
    // to ensure page hooks mount immediately without requiring user interaction.
    const isDesktop = typeof window !== 'undefined' && !!window.electron?.isDesktop;
    if (isDesktop && !didAttemptDesktopRestore.current && pathname === '/dashboard' && hasTabs) {
      const refreshedState = useTabsStore.getState();
      const activeTab = selectActiveTab(refreshedState);
      const restorePath = activeTab?.path;

      didAttemptDesktopRestore.current = true;

      if (restorePath && restorePath !== '/dashboard') {
        lastSyncedPath.current = restorePath;
        router.replace(restorePath);
        return;
      }
    }

    // Skip if we already synced this path
    if (lastSyncedPath.current === pathname) return;

    // If no tabs exist, create one from current path
    if (state.tabs.length === 0) {
      state.createTab({ path: pathname });
      lastSyncedPath.current = pathname;
      return;
    }

    // Get active tab's current path
    const activeTab = selectActiveTab(state);

    // If active tab already at this path, just update sync ref
    if (activeTab?.path === pathname) {
      lastSyncedPath.current = pathname;
      return;
    }

    // Navigate within the active tab
    state.navigateInActiveTab(pathname);
    lastSyncedPath.current = pathname;
  }, [pathname, rehydrated, router]);
}
