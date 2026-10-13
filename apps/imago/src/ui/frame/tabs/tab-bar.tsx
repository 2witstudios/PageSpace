'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import useSWR from 'swr';
import { useUIStore } from '@/retained/stores/useUIStore';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { useUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import type { UiState } from '../../store/state';
import { pageKey } from '../../files/page-object/page-object';
import { stageFor, type Stage } from '../stage/stage';
import { closeTab, goBack, goForward, sectionPath, tabFor, tabsStorageKey } from './tabs-model';
import { pageTabOf, tabLabelFor } from './tab-label';
import { renderTab, renderTabBar } from './tab-bar.render';

const selectTabs = (state: UiState) => state.resources.openTabs;
const selectKey = (state: UiState) => state.resources.tabsKey;
const selectHistory = (state: UiState) => state.resources.tabHistory;

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

type TabItemProps = { readonly path: string; readonly selected: boolean; readonly onClose: () => void };

/** A page tab's title and type come from the page API, sharing the page view's cache. */
function PageTab({ path, pageId, selected, onClose }: TabItemProps & { readonly pageId: string }) {
  const { data } = useSWR<unknown>(pageKey(pageId));
  const page = pageTabOf(data);
  const look = page === null ? { icon: 'page' as const, hue: null } : pageTypeIcons[page.type];
  return renderTab({ path, title: page?.title ?? 'Loading…', icon: look.icon, hue: look.hue, selected, onClose });
}

function TabItem(props: TabItemProps) {
  const label = tabLabelFor(props.path);
  if (label.kind === 'page') return <PageTab {...props} pageId={label.pageId} />;
  if (label.kind === 'conversation') return renderTab({ ...props, title: 'Direct message', icon: 'messages', hue: null });
  return renderTab({ ...props, title: label.title, icon: 'settings', hue: null });
}

export type TabBarProps = {
  readonly stage: Stage;
  /** Whose tabs these are: the drive the spine links into (DEC-C6: per drive). */
  readonly driveKey: string;
};

/**
 * The open-pages tab bar (IMC-1.5). Every navigation opens the middle's object as a tab and
 * records the visit; tabs persist per drive under imago's own key. Closing the active tab
 * moves to its neighbour, and closing the last one closes the middle (its section, where
 * Imago is the ground).
 */
export function TabBar({ stage, driveKey }: TabBarProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const tabs = useUiState(selectTabs);
  const loadedKey = useUiState(selectKey);
  const history = useUiState(selectHistory);
  const key = tabsStorageKey(driveKey);

  useEffect(() => {
    dispatch(transactions.syncTabs, { key, stored: storage.read(key), path: pathname, tab: tabFor(stageFor(pathname), pathname) });
  }, [key, pathname]);

  useEffect(() => {
    if (loadedKey === key) storage.write(key, JSON.stringify(tabs));
  }, [tabs, loadedKey, key]);

  const close = (path: string) => {
    const result = closeTab(tabs, path, pathname);
    dispatch(transactions.setTabs, result.tabs);
    if (path !== pathname) return;
    router.push(result.next ?? sectionPath(stage));
  };

  const back = history === null ? null : goBack(history);
  const forward = history === null ? null : goForward(history);

  return renderTabBar({
    tabs: tabs.map((tab) => (
      <TabItem key={tab.path} path={tab.path} selected={tab.path === pathname} onClose={() => close(tab.path)} />
    )),
    canBack: back !== null,
    canForward: forward !== null,
    onBack: () => {
      if (back === null) return;
      dispatch(transactions.stepBack, undefined);
      router.push(back.current);
    },
    onForward: () => {
      if (forward === null) return;
      dispatch(transactions.stepForward, undefined);
      router.push(forward.current);
    },
    onNew: () => useUIStore.getState().openQuickCreate(null),
  });
}
