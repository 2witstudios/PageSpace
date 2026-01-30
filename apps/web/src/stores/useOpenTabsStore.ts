import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PageType } from '@pagespace/lib/client-safe';

export type TabPageType = `${PageType}`;

export interface Tab {
  id: string; // pageId
  driveId: string;
  title: string;
  type: TabPageType;
  isPinned: boolean;
}

interface OpenTabsState {
  // State
  tabs: Tab[];
  activeTabId: string | null;
  rehydrated: boolean;

  // Actions
  setRehydrated: () => void;
  openTab: (tab: Omit<Tab, 'isPinned'>) => void;
  openTabInBackground: (tab: Omit<Tab, 'isPinned'>) => void;
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
  updateTabTitle: (tabId: string, title: string) => void;
}

export const useOpenTabsStore = create<OpenTabsState>()(
  persist(
    (set, get) => ({
      // Initial state
      tabs: [],
      activeTabId: null,
      rehydrated: false,

      setRehydrated: () => {
        set({ rehydrated: true });
      },

      openTab: (tabData) => {
        const { tabs, activeTabId } = get();
        const existingTab = tabs.find(t => t.id === tabData.id);

        if (existingTab) {
          // Tab already open, just activate it
          set({ activeTabId: tabData.id });
          return;
        }

        // Find insert position: after active tab, or after all pinned tabs
        const activeTab = tabs.find(t => t.id === activeTabId);
        const activeIndex = tabs.findIndex(t => t.id === activeTabId);

        let insertIndex: number;
        if (activeTab?.isPinned) {
          // If active tab is pinned, insert after all pinned tabs
          const lastPinnedIndex = tabs.reduce((last, t, i) => t.isPinned ? i : last, -1);
          insertIndex = lastPinnedIndex + 1;
        } else {
          insertIndex = activeIndex >= 0 ? activeIndex + 1 : tabs.length;
        }

        const newTab: Tab = { ...tabData, isPinned: false };
        const newTabs = [...tabs];
        newTabs.splice(insertIndex, 0, newTab);

        set({
          tabs: newTabs,
          activeTabId: tabData.id,
        });
      },

      openTabInBackground: (tabData) => {
        const { tabs, activeTabId } = get();
        const existingTab = tabs.find(t => t.id === tabData.id);

        if (existingTab) {
          // Tab already open, don't change active
          return;
        }

        // Find insert position: after active tab, or after all pinned tabs
        const activeTab = tabs.find(t => t.id === activeTabId);
        const activeIndex = tabs.findIndex(t => t.id === activeTabId);

        let insertIndex: number;
        if (activeTab?.isPinned) {
          // If active tab is pinned, insert after all pinned tabs
          const lastPinnedIndex = tabs.reduce((last, t, i) => t.isPinned ? i : last, -1);
          insertIndex = lastPinnedIndex + 1;
        } else {
          insertIndex = activeIndex >= 0 ? activeIndex + 1 : tabs.length;
        }

        const newTab: Tab = { ...tabData, isPinned: false };
        const newTabs = [...tabs];
        newTabs.splice(insertIndex, 0, newTab);

        set({ tabs: newTabs });
      },

      closeTab: (tabId) => {
        const { tabs, activeTabId } = get();
        const tabIndex = tabs.findIndex(t => t.id === tabId);

        if (tabIndex === -1) return;

        const newTabs = tabs.filter(t => t.id !== tabId);

        // If closing active tab, activate adjacent tab
        let newActiveTabId = activeTabId;
        if (tabId === activeTabId) {
          if (newTabs.length === 0) {
            newActiveTabId = null;
          } else if (tabIndex >= newTabs.length) {
            // Was last tab, activate new last
            newActiveTabId = newTabs[newTabs.length - 1].id;
          } else {
            // Activate tab that took its place
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

        // Keep pinned tabs and the specified tab
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

        // Keep tabs up to and including tabId, plus any pinned tabs to the right
        const newTabs = tabs.filter((t, i) => i <= tabIndex || t.isPinned);

        // If active tab was closed, activate the reference tab
        const activeStillExists = newTabs.some(t => t.id === activeTabId);

        set({
          tabs: newTabs,
          activeTabId: activeStillExists ? activeTabId : tabId,
        });
      },

      closeAllTabs: () => {
        const { tabs } = get();
        // Keep only pinned tabs
        const pinnedTabs = tabs.filter(t => t.isPinned);

        set({
          tabs: pinnedTabs,
          activeTabId: pinnedTabs.length > 0 ? pinnedTabs[0].id : null,
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

        let newIndex: number;
        if (direction === 'next') {
          newIndex = (currentIndex + 1) % tabs.length;
        } else {
          newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        }

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

        // Create tabs with original indices for stable sort
        const tabsWithIndex = tabs.map((t, i) => ({
          tab: i === tabIndex ? { ...t, isPinned: true } : t,
          originalIndex: i,
        }));

        // Stable sort: pinned first, then by original index
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

      updateTabTitle: (tabId, title) => {
        const { tabs } = get();
        const tabIndex = tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const newTabs = [...tabs];
        newTabs[tabIndex] = { ...newTabs[tabIndex], title };

        set({ tabs: newTabs });
      },
    }),
    {
      name: 'open-tabs-storage',
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

// Selector helpers for common patterns
export const selectTabCount = (state: OpenTabsState) => state.tabs.length;
export const selectHasMultipleTabs = (state: OpenTabsState) => state.tabs.length > 1;
export const selectActiveTab = (state: OpenTabsState) =>
  state.tabs.find(t => t.id === state.activeTabId) ?? null;
