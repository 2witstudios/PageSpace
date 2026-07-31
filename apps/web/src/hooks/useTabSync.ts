"use client";

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTabsStore, selectActiveTab } from '@/stores/useTabsStore';
import { toHref } from '@/lib/tabs/tab-navigation';

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
  const search = useSearchParams().toString();
  const router = useRouter();
  const lastSyncedHref = useRef<string | null>(null);

  const rehydrated = useTabsStore((state) => state.rehydrated);
  const setDesktopRestoreAttempted = useTabsStore((state) => state.setDesktopRestoreAttempted);

  useEffect(() => {
    // Wait for store to rehydrate from localStorage
    if (!rehydrated) return;

    const href = toHref(pathname, search);

    const state = useTabsStore.getState();
    const hasTabs = state.tabs.length > 0;

    // Heal invalid state: tabs exist but activeTabId is missing/stale.
    if (hasTabs && !selectActiveTab(state)) {
      state.setActiveTab(state.tabs[0].id);
    }

    // Desktop bootstrap: app starts at /dashboard, so restore the active tab route once
    // to ensure page hooks mount immediately without requiring user interaction.
    // Mark the attempt on first hydrated pass so it cannot trigger mid-session,
    // including across layout remounts (e.g. route-group transitions).
    const isDesktop = !!window.electron?.isDesktop;
    const desktopRestoreAttempted = useTabsStore.getState().desktopRestoreAttempted;
    if (isDesktop && !desktopRestoreAttempted) {
      setDesktopRestoreAttempted(true);

      if (pathname === '/dashboard' && hasTabs) {
        const activeTab = selectActiveTab(useTabsStore.getState());
        const restoreHref = activeTab ? toHref(activeTab.path, activeTab.search) : undefined;

        if (restoreHref && restoreHref !== '/dashboard') {
          // Guard against immediate re-runs (e.g. strict mode) before replace updates pathname.
          // Keep '/dashboard' marked as already handled so we don't sync it into tab history.
          lastSyncedHref.current = href;
          router.replace(restoreHref);
          return;
        }
      }
    }

    // Skip if we already synced this href
    if (lastSyncedHref.current === href) return;

    // Re-read after potential healing / restore
    const currentState = useTabsStore.getState();

    // If no tabs exist, create one from current path
    if (currentState.tabs.length === 0) {
      currentState.createTab({ path: pathname, search });
      lastSyncedHref.current = href;
      return;
    }

    // Get active tab's current path
    const activeTab = selectActiveTab(currentState);

    // If active tab already at this path, just update sync ref
    if (activeTab?.path === pathname && activeTab?.search === search) {
      lastSyncedHref.current = href;
      return;
    }

    // Navigate within the active tab
    currentState.navigateInActiveTab(pathname, search);
    lastSyncedHref.current = href;
  }, [pathname, search, rehydrated, router, setDesktopRestoreAttempted]);
}
