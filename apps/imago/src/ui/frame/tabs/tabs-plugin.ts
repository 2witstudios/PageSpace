import type { UiSlice, UiState } from '../../store/state';
import {
  activeTabOf,
  navigateTabs,
  openTabInBackground,
  parseTabs,
  restoreActive,
  rewindTab,
  stepTab,
  type PopDirection,
  type Tab,
  type TabStrip,
} from './tabs-model';

type TabsResources = {
  /** The open tabs of the drive named by `tabsKey` (DEC-C6: client state, per drive). */
  readonly openTabs: readonly Tab[];
  /** The tab the viewer is in (its id): a navigation loads into it. Null when none is. */
  readonly activeTab: string | null;
  /** The next navigation opens a new tab instead of loading into the active one (New tab). */
  readonly newTabPending: boolean;
  /** Whose tabs are loaded: the storage key they were read from; null before the first read. */
  readonly tabsKey: string | null;
};

const withTabs = (state: UiState, patch: Partial<TabsResources>): UiState => ({
  ...state,
  resources: { ...state.resources, ...patch },
});

const stripOf = (state: UiState): TabStrip => ({ tabs: state.resources.openTabs, active: state.resources.activeTab });

const withActiveTab = (state: UiState, tab: Tab): UiState =>
  withTabs(state, { openTabs: state.resources.openTabs.map((entry) => (entry.id === tab.id ? tab : entry)) });

const step = (state: UiState, direction: 'back' | 'forward'): UiState => {
  const active = activeTabOf(stripOf(state));
  const next = active === null ? null : stepTab(active, direction);
  return next === null ? state : withActiveTab(state, next);
};

export type SyncTabs = {
  readonly key: string;
  readonly stored: string | null;
  /** The tab path of where the viewer is now; null when that is not a tab's object. */
  readonly path: string | null;
  /** The id a tab gets if this navigation opens one. */
  readonly id: string;
  /** The browser's own Back or Forward brought the viewer here. */
  readonly pop: boolean;
  /** Which way it went, when the browser can say. */
  readonly direction?: PopDirection;
};

/**
 * The tab bar's state (IMC-1.5). `syncTabs` runs on every navigation: on a new drive it reads
 * that drive's stored tabs first, then loads the current page (if it is a tab's object) into
 * the active tab as a step in that tab's own history, as browser tabs do. The browser's Back
 * and Forward move within the active tab's history. New tabs open only when asked for: New
 * tab, ⌘/Ctrl-click or middle-click.
 */
export const tabsPlugin = {
  resources: (): TabsResources => ({ openTabs: [], activeTab: null, newTabPending: false, tabsKey: null }),
  transactions: {
    syncTabs: (state: UiState, { key, stored, path, id, pop, direction = null }: SyncTabs): UiState => {
      const { resources } = state;
      const loaded = resources.tabsKey === key;
      const base: TabStrip = loaded ? stripOf(state) : restoreActive(parseTabs(stored), path);
      const active = activeTabOf(base);
      const rewound = path !== null && pop && active !== null ? rewindTab(active, path, direction) : null;
      const strip =
        path === null || (rewound !== null && rewound === active)
          ? base
          : rewound !== null
            ? { tabs: base.tabs.map((tab) => (tab.id === rewound.id ? rewound : tab)), active: base.active }
            : navigateTabs(base, path, id, resources.newTabPending);
      const newTabPending = path === null ? resources.newTabPending : false;
      const unchanged =
        loaded &&
        strip.tabs === resources.openTabs &&
        strip.active === resources.activeTab &&
        newTabPending === resources.newTabPending;
      return unchanged
        ? state
        : withTabs(state, { openTabs: strip.tabs, activeTab: strip.active, newTabPending, tabsKey: key });
    },
    setTabs: (state: UiState, openTabs: readonly Tab[]): UiState => {
      const { activeTab } = state.resources;
      const stillOpen = activeTab !== null && openTabs.some((tab) => tab.id === activeTab);
      return withTabs(state, { openTabs, activeTab: stillOpen ? activeTab : null });
    },
    activateTab: (state: UiState, id: string): UiState =>
      state.resources.activeTab === id || !state.resources.openTabs.some((tab) => tab.id === id)
        ? state
        : withTabs(state, { activeTab: id }),
    openBackgroundTab: (state: UiState, { path, id }: { readonly path: string; readonly id: string }): UiState =>
      withTabs(state, { openTabs: openTabInBackground(stripOf(state), path, id).tabs }),
    /** New tab, as in a browser: a tab beside the active one, on the drive's home, made active. */
    openNewTab: (state: UiState, { path, id }: { readonly path: string; readonly id: string }): UiState => {
      const strip = navigateTabs(stripOf(state), path, id, true);
      return withTabs(state, { openTabs: strip.tabs, activeTab: strip.active, newTabPending: false });
    },
    setNewTabPending: (state: UiState, newTabPending: boolean): UiState =>
      state.resources.newTabPending === newTabPending ? state : withTabs(state, { newTabPending }),
    stepBack: (state: UiState, _: void): UiState => step(state, 'back'),
    stepForward: (state: UiState, _: void): UiState => step(state, 'forward'),
  },
} satisfies UiSlice;
