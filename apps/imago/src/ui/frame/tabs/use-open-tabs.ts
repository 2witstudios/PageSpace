'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import type { UiState } from '../../store/state';
import type { Stage } from '../stage/stage';
import { basePathRelative } from '@/lib/auth/sign-in-url';
import { closeTab, createTabId, popDirection, sectionPath, serializeTabs, tabPathFor, tabsStorageKey, type Tab } from './tabs-model';

const selectTabs = (state: UiState) => state.resources.openTabs;
const selectActive = (state: UiState) => state.resources.activeTab;
const selectKey = (state: UiState) => state.resources.tabsKey;

/**
 * The browser's position in this window's history (the Navigation API), so a popstate can say
 * which way it went; null where the browser does not offer it.
 */
const historyIndex = (): number | null => {
  const navigation = (window as { navigation?: { currentEntry?: { index?: number } | null } }).navigation;
  const index = navigation?.currentEntry?.index;
  return typeof index === 'number' && index >= 0 ? index : null;
};

type Popped = { readonly path: string | null; readonly index: number | null };

/** localStorage, which can throw (private windows, blocked site data): tabs then live for the session. */
const storage = {
  read: (key: string): string | null => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write: (key: string, value: string): void => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The tabs still work for this window.
    }
  },
};

export type OpenTabs = {
  readonly tabs: readonly Tab[];
  /** The tab the viewer is in (its id), if any. */
  readonly activeId: string | null;
  readonly pathname: string;
  /** Whether a tab is the one on screen: the active tab, showing where the viewer is. */
  readonly isCurrent: (tab: Tab) => boolean;
  /** Makes a tab active; its link then navigates to it. */
  readonly select: (id: string) => void;
  /** Closes one tab (useCloseTab). */
  readonly close: (id: string, whenLast?: 'section' | 'stay') => void;
  /** Closes every tab and stays where the viewer is. */
  readonly closeAll: () => void;
};

/**
 * Closes one tab. Closing the one on screen moves to its neighbour; with none left it goes to
 * the section in a tab of its own ('section': the tab bar, Close page) or stays put ('stay':
 * the phone's open-pages sheet). It only reads the tabs, so any control can close one.
 */
export function useCloseTab(stage: Stage): (id: string, whenLast?: 'section' | 'stay') => void {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const tabs = useUiState(selectTabs);
  const activeId = useUiState(selectActive);
  return (id, whenLast = 'section') => {
    const closing = tabs.find((tab) => tab.id === id);
    const onScreen = closing !== undefined && closing.id === activeId && closing.path === pathname;
    const result = closeTab({ tabs, active: activeId }, id);
    dispatch(transactions.setTabs, result.tabs);
    // The neighbour becomes active even off screen, so the next place loads into it rather
    // than opening a tab.
    if (result.next !== null) dispatch(transactions.activateTab, result.next.id);
    if (!onScreen) return;
    if (result.next !== null) return router.push(result.next.path);
    if (whenLast === 'stay') return;
    // As in classic, closing the last tab leaves one, here on the section, even when the
    // viewer is already there (no navigation then syncs one in). The root is no place: the
    // sync opens the tab where its redirect lands.
    const section = sectionPath(stage);
    if (tabPathFor(section) !== null) dispatch(transactions.openNewTab, { path: section, id: createTabId() });
    if (section !== pathname) router.push(section);
  };
}

/**
 * Keeps a drive's tabs in step with the URL, browser-style as in classic: every navigation
 * loads into the active tab as a step in that tab's own history (a new tab only when there is
 * none, or one was asked for), the browser's Back and Forward move within it, and tabs persist
 * per drive under imago's own key. Mount it once per layout, wherever the viewer goes: the tab
 * bar on desktop, TabSync in the phone shell.
 */
export function useTabSync(driveKey: string): void {
  const pathname = usePathname() ?? '/';
  const tabs = useUiState(selectTabs);
  const activeId = useUiState(selectActive);
  const loadedKey = useUiState(selectKey);
  const key = tabsStorageKey(driveKey);
  // Set by the browser's own Back or Forward: where it landed, so only the sync for that very
  // place moves within the active tab's history instead of adding a step.
  const popped = useRef<Popped | null>(null);
  // Where the browser was in its history at the last sync.
  const lastIndex = useRef<number | null>(null);

  useEffect(() => {
    const onPopState = () => {
      popped.current = { path: basePathRelative(window.location.pathname), index: historyIndex() };
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const landed = popped.current;
    popped.current = null;
    const pop = landed !== null && landed.path === pathname;
    const direction = pop ? popDirection(lastIndex.current, landed.index) : null;
    lastIndex.current = historyIndex();
    dispatch(transactions.syncTabs, {
      key,
      stored: storage.read(key),
      path: tabPathFor(pathname),
      id: createTabId(),
      pop,
      direction,
    });
  }, [key, pathname]);

  useEffect(() => {
    if (loadedKey === key) storage.write(key, serializeTabs({ tabs, active: activeId }));
  }, [tabs, activeId, loadedKey, key]);
}

/** useTabSync as a component, for the phone shell, which has no tab bar to carry it. */
export function TabSync({ driveKey }: { readonly driveKey: string }): null {
  useTabSync(driveKey);
  return null;
}

/**
 * The open tabs of the loaded drive (useTabSync keeps them current). The tab bar and the
 * phone's open-pages sheet both read them.
 */
export function useOpenTabs(stage: Stage): OpenTabs {
  const pathname = usePathname() ?? '/';
  const tabs = useUiState(selectTabs);
  const activeId = useUiState(selectActive);
  const close = useCloseTab(stage);
  const isCurrent = (tab: Tab) => tab.id === activeId && tab.path === pathname;

  return {
    tabs,
    activeId,
    pathname,
    isCurrent,
    select: (id) => dispatch(transactions.activateTab, id),
    close,
    closeAll: () => dispatch(transactions.setTabs, []),
  };
}
