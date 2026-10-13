import type { UiSlice, UiState } from '../../store/state';
import { goBack, goForward, openTab, parseTabs, visit, type History, type Tab } from './tabs-model';

type TabsResources = {
  /** The open tabs of the drive named by `tabsKey` (DEC-C6: client state, per drive). */
  readonly openTabs: readonly Tab[];
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
 * reads that drive's stored tabs first, then opens the current page's tab (if it is one)
 * and records the visit for Back and Forward.
 */
export const tabsPlugin = {
  resources: (): TabsResources => ({ openTabs: [], tabsKey: null, tabHistory: null }),
  transactions: {
    syncTabs: (
      state: UiState,
      { key, stored, path, tab }: { readonly key: string; readonly stored: string | null; readonly path: string; readonly tab: Tab | null },
    ): UiState => {
      const base = state.resources.tabsKey === key ? state.resources.openTabs : parseTabs(stored);
      const openTabs = tab === null ? base : openTab(base, tab);
      const history = state.resources.tabHistory;
      const tabHistory = history === null ? { back: [], current: path, forward: [] } : visit(history, path);
      return openTabs === state.resources.openTabs && state.resources.tabsKey === key && tabHistory === history
        ? state
        : withTabs(state, { openTabs, tabsKey: key, tabHistory });
    },
    setTabs: (state: UiState, openTabs: readonly Tab[]): UiState => withTabs(state, { openTabs }),
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
