/**
 * useTabsStore - Browser-style tab management with per-tab navigation history
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createTab as createTabFn,
  navigateInTab as navigateInTabFn,
  goBack as goBackFn,
  goForward as goForwardFn,
  canGoBack,
  canGoForward,
  type Tab,
  type CreateTabOptions,
} from '@/lib/tabs/tab-navigation';

export type { Tab };

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  rehydrated: boolean;

  // Actions
  setRehydrated: () => void;
  createTab: (options?: CreateTabOptions & { activate?: boolean }) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (keepTabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (tabId: string) => void;
  setActiveTabByIndex: (index: number) => void;
  cycleTab: (direction: 'next' | 'prev') => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;
  pinTab: (tabId: string) => void;
  unpinTab: (tabId: string) => void;
  navigateInTab: (tabId: string, path: string) => void;
  navigateInActiveTab: (path: string) => void;
  goBackInActiveTab: () => void;
  goForwardInActiveTab: () => void;
  duplicateTab: (tabId: string) => void;

  // Selectors (attached for convenience)
  selectActiveTab: (state: TabsState) => Tab | null;
  selectCanGoBack: (state: TabsState) => boolean;
  selectCanGoForward: (state: TabsState) => boolean;
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      rehydrated: false,

      setRehydrated: () => set({ rehydrated: true }),

      createTab: (options = {}) => {
        const { activate = true, ...tabOptions } = options;
        const { tabs, activeTabId } = get();
        const newTab = createTabFn(tabOptions);

        // Find insert position: after active tab, or after all pinned tabs
        const activeTab = tabs.find(t => t.id === activeTabId);
        const activeIndex = tabs.findIndex(t => t.id === activeTabId);

        let insertIndex: number;
        if (activeTab?.isPinned) {
          const lastPinnedIndex = tabs.reduce((last, t, i) => t.isPinned ? i : last, -1);
          insertIndex = lastPinnedIndex + 1;
        } else {
          insertIndex = activeIndex >= 0 ? activeIndex + 1 : tabs.length;
        }

        const newTabs = [...tabs];
        newTabs.splice(insertIndex, 0, newTab);

        set({
          tabs: newTabs,
          activeTabId: activate ? newTab.id : activeTabId,
        });
      },

      closeTab: (tabId) => {
        const { tabs, activeTabId } = get();
        const tabIndex = tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const newTabs = tabs.filter(t => t.id !== tabId);

        // If closing last tab, create new one at dashboard
        if (newTabs.length === 0) {
          const dashboardTab = createTabFn({ path: '/dashboard' });
          set({
            tabs: [dashboardTab],
            activeTabId: dashboardTab.id,
          });
          return;
        }

        // If closing active tab, activate adjacent tab
        let newActiveTabId = activeTabId;
        if (tabId === activeTabId) {
          if (tabIndex >= newTabs.length) {
            newActiveTabId = newTabs[newTabs.length - 1].id;
          } else {
            newActiveTabId = newTabs[tabIndex].id;
          }
        }

        set({
          tabs: newTabs,
          activeTabId: newActiveTabId,
        });
      },

      closeOtherTabs: (keepTabId) => {
        const { tabs } = get();
        const tabToKeep = tabs.find(t => t.id === keepTabId);
        if (!tabToKeep) return;

        const newTabs = tabs.filter(t => t.isPinned || t.id === keepTabId);
        set({
          tabs: newTabs,
          activeTabId: keepTabId,
        });
      },

      closeTabsToRight: (tabId) => {
        const { tabs, activeTabId } = get();
        const tabIndex = tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const newTabs = tabs.filter((t, i) => i <= tabIndex || t.isPinned);
        const activeStillExists = newTabs.some(t => t.id === activeTabId);

        set({
          tabs: newTabs,
          activeTabId: activeStillExists ? activeTabId : tabId,
        });
      },

      closeAllTabs: () => {
        const { tabs } = get();
        const pinnedTabs = tabs.filter(t => t.isPinned);

        if (pinnedTabs.length === 0) {
          const dashboardTab = createTabFn({ path: '/dashboard' });
          set({
            tabs: [dashboardTab],
            activeTabId: dashboardTab.id,
          });
          return;
        }

        set({
          tabs: pinnedTabs,
          activeTabId: pinnedTabs[0].id,
        });
      },

      setActiveTab: (tabId) => {
        const { tabs } = get();
        if (tabs.some(t => t.id === tabId)) {
          set({ activeTabId: tabId });
        }
      },

      setActiveTabByIndex: (index) => {
        const { tabs } = get();
        if (index >= 0 && index < tabs.length) {
          set({ activeTabId: tabs[index].id });
        }
      },

      cycleTab: (direction) => {
        const { tabs, activeTabId } = get();
        if (tabs.length <= 1) return;

        const currentIndex = tabs.findIndex(t => t.id === activeTabId);
        if (currentIndex === -1) return;

        const newIndex = direction === 'next'
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;

        set({ activeTabId: tabs[newIndex].id });
      },

      reorderTab: (fromIndex, toIndex) => {
        const { tabs } = get();
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || fromIndex >= tabs.length) return;
        if (toIndex < 0 || toIndex >= tabs.length) return;

        const newTabs = [...tabs];
        const [movedTab] = newTabs.splice(fromIndex, 1);
        newTabs.splice(toIndex, 0, movedTab);

        set({ tabs: newTabs });
      },

      pinTab: (tabId) => {
        const { tabs } = get();
        const tabIndex = tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const tabsWithIndex = tabs.map((t, i) => ({
          tab: i === tabIndex ? { ...t, isPinned: true } : t,
          originalIndex: i,
        }));

        tabsWithIndex.sort((a, b) => {
          if (a.tab.isPinned && !b.tab.isPinned) return -1;
          if (!a.tab.isPinned && b.tab.isPinned) return 1;
          return a.originalIndex - b.originalIndex;
        });

        set({ tabs: tabsWithIndex.map(({ tab }) => tab) });
      },

      unpinTab: (tabId) => {
        const { tabs } = get();
        const tabIndex = tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const newTabs = [...tabs];
        newTabs[tabIndex] = { ...newTabs[tabIndex], isPinned: false };

        set({ tabs: newTabs });
      },

      navigateInTab: (tabId, path) => {
        const { tabs } = get();
        const tabIndex = tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const newTabs = [...tabs];
        newTabs[tabIndex] = navigateInTabFn(newTabs[tabIndex], path);

        set({ tabs: newTabs });
      },

      navigateInActiveTab: (path) => {
        const { activeTabId, navigateInTab } = get();
        if (!activeTabId) return;
        navigateInTab(activeTabId, path);
      },

      goBackInActiveTab: () => {
        const { tabs, activeTabId } = get();
        if (!activeTabId) return;

        const tabIndex = tabs.findIndex(t => t.id === activeTabId);
        if (tabIndex === -1) return;

        const newTabs = [...tabs];
        newTabs[tabIndex] = goBackFn(newTabs[tabIndex]);

        set({ tabs: newTabs });
      },

      goForwardInActiveTab: () => {
        const { tabs, activeTabId } = get();
        if (!activeTabId) return;

        const tabIndex = tabs.findIndex(t => t.id === activeTabId);
        if (tabIndex === -1) return;

        const newTabs = [...tabs];
        newTabs[tabIndex] = goForwardFn(newTabs[tabIndex]);

        set({ tabs: newTabs });
      },

      duplicateTab: (tabId) => {
        const { tabs } = get();
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;

        const newTab = createTabFn({ path: tab.path });
        const tabIndex = tabs.findIndex(t => t.id === tabId);

        const newTabs = [...tabs];
        newTabs.splice(tabIndex + 1, 0, newTab);

        set({
          tabs: newTabs,
          activeTabId: newTab.id,
        });
      },

      // Selectors
      selectActiveTab: (state) => state.tabs.find(t => t.id === state.activeTabId) ?? null,

      selectCanGoBack: (state) => {
        const activeTab = state.tabs.find(t => t.id === state.activeTabId);
        return activeTab ? canGoBack(activeTab) : false;
      },

      selectCanGoForward: (state) => {
        const activeTab = state.tabs.find(t => t.id === state.activeTabId);
        return activeTab ? canGoForward(activeTab) : false;
      },
    }),
    {
      name: 'tabs-storage',
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setRehydrated();
      },
    }
  )
);

// Export standalone selectors
export const selectTabCount = (state: TabsState) => state.tabs.length;
export const selectHasMultipleTabs = (state: TabsState) => state.tabs.length > 1;
export const selectActiveTab = (state: TabsState) =>
  state.tabs.find(t => t.id === state.activeTabId) ?? null;
