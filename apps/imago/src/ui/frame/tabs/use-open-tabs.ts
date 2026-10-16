'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import type { UiState } from '../../store/state';
import { stageFor, type Stage } from '../stage/stage';
import { closeTab, sectionPath, tabFor, tabsStorageKey, type Tab } from './tabs-model';

const selectTabs = (state: UiState) => state.resources.openTabs;
const selectKey = (state: UiState) => state.resources.tabsKey;

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
  readonly pathname: string;
  /**
   * Closes one tab. Closing the active one moves to its neighbour; with none left it goes to the
   * section ('section', the tab bar) or stays put ('stay', the phone's open-pages sheet).
   */
  readonly close: (path: string, whenLast?: 'section' | 'stay') => void;
  /** Closes every tab and stays where the viewer is. */
  readonly closeAll: () => void;
};

/**
 * The open tabs of a drive: a navigation loads the middle's object into the active tab (a new
 * tab only when there is none, or one was asked for), and tabs persist per drive under imago's
 * own key. The tab bar and the phone's open-pages sheet both read them.
 */
export function useOpenTabs(stage: Stage, driveKey: string): OpenTabs {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const tabs = useUiState(selectTabs);
  const loadedKey = useUiState(selectKey);
  const key = tabsStorageKey(driveKey);

  useEffect(() => {
    dispatch(transactions.syncTabs, { key, stored: storage.read(key), path: pathname, tab: tabFor(stageFor(pathname), pathname) });
  }, [key, pathname]);

  useEffect(() => {
    if (loadedKey === key) storage.write(key, JSON.stringify(tabs));
  }, [tabs, loadedKey, key]);

  return {
    tabs,
    pathname,
    close: (path, whenLast = 'section') => {
      const result = closeTab(tabs, path, pathname);
      dispatch(transactions.setTabs, result.tabs);
      if (path !== pathname) return;
      if (result.next !== null) router.push(result.next);
      else if (whenLast === 'section') router.push(sectionPath(stage));
    },
    closeAll: () => dispatch(transactions.setTabs, []),
  };
}
