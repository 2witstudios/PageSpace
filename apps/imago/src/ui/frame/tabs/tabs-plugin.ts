import type { UiSlice, UiState } from '../../store/state';
import { goBack, goForward, navigateTabs, openTabInBackground, parseTabs, visit, type History, type Tab } from './tabs-model';

type TabsResources = {
  /** The open tabs of the drive named by `tabsKey` (DEC-C6: client state, per drive). */
  readonly openTabs: readonly Tab[];
  /** The tab the viewer is in (its path): a navigation loads into it. Null when none is. */
  readonly activeTab: string | null;
  /** The next navigation opens a new tab instead of loading into the active one (New tab). */
  readonly newTabPending: boolean;
  /** Whose tabs are loaded: the storage key they were read from; null before the first read. */
  readonly tabsKey: string | null;
  /** Back and Forward in this window. */
  readonly tabHistory: History | null;
};

const withTabs = (state: UiState, patch: Partial<TabsResources>): UiState => ({
  ...state,
  resources: { ...state.resources, ...patch },
});

/**
 * The tab bar's state (IMC-1.5). `syncTabs` runs on every navigation: on a new drive it
 * reads that drive's stored tabs first, then loads the current page (if it is a tab's
 * object) into the active tab, as browser tabs do, and records the visit for Back and
 * Forward. New tabs open only when asked for: New tab, ⌘/Ctrl-click or middle-click.
 */
export const tabsPlugin = {
  resources: (): TabsResources => ({ openTabs: [], activeTab: null, newTabPending: false, tabsKey: null, tabHistory: null }),
  transactions: {
    syncTabs: (
      state: UiState,
      { key, stored, path, tab }: { readonly key: string; readonly stored: string | null; readonly path: string; readonly tab: Tab | null },
    ): UiState => {
      const { resources } = state;
      const loaded = resources.tabsKey === key;
      const base = loaded
        ? { tabs: resources.openTabs, active: resources.activeTab }
        : { tabs: parseTabs(stored), active: null };
      const strip = tab === null ? base : navigateTabs(base, tab, resources.newTabPending);
      const newTabPending = tab === null ? resources.newTabPending : false;
      const history = resources.tabHistory;
      const tabHistory = history === null ? { back: [], current: path, forward: [] } : visit(history, path);
      const unchanged =
        strip.tabs === resources.openTabs &&
        strip.active === resources.activeTab &&
        newTabPending === resources.newTabPending &&
        loaded &&
        tabHistory === history;
      return unchanged
        ? state
        : withTabs(state, { openTabs: strip.tabs, activeTab: strip.active, newTabPending, tabsKey: key, tabHistory });
    },
    setTabs: (state: UiState, openTabs: readonly Tab[]): UiState => {
      const { activeTab } = state.resources;
      const stillOpen = activeTab !== null && openTabs.some((tab) => tab.path === activeTab);
      return withTabs(state, { openTabs, activeTab: stillOpen ? activeTab : null });
    },
    openBackgroundTab: (state: UiState, tab: Tab): UiState => {
      const { openTabs, activeTab } = state.resources;
      const strip = openTabInBackground({ tabs: openTabs, active: activeTab }, tab);
      return strip.tabs === openTabs ? state : withTabs(state, { openTabs: strip.tabs });
    },
    setNewTabPending: (state: UiState, newTabPending: boolean): UiState =>
      state.resources.newTabPending === newTabPending ? state : withTabs(state, { newTabPending }),
    stepBack: (state: UiState, _: void): UiState => {
      const history = state.resources.tabHistory;
      const back = history === null ? null : goBack(history);
      return back === null ? state : withTabs(state, { tabHistory: back });
    },
    stepForward: (state: UiState, _: void): UiState => {
      const history = state.resources.tabHistory;
      const forward = history === null ? null : goForward(history);
      return forward === null ? state : withTabs(state, { tabHistory: forward });
    },
  },
} satisfies UiSlice;
