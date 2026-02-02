/**
 * Tab Navigation Logic
 * Pure functions for browser-style tab navigation with per-tab history
 */

import type { PageType } from '@pagespace/lib/client-safe';

export interface Tab {
  id: string;
  path: string;
  history: string[];
  historyIndex: number;
  isPinned: boolean;
  // Cached metadata for display (like browser tab titles)
  title?: string;
  pageType?: PageType;
}

export interface CreateTabOptions {
  id?: string;
  path?: string;
  isPinned?: boolean;
  title?: string;
  pageType?: PageType;
}

export interface TabMetaUpdate {
  title?: string;
  pageType?: PageType;
}

const generateId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const createTab = ({
  id = generateId(),
  path = '/dashboard',
  isPinned = false,
  title,
  pageType,
}: CreateTabOptions = {}): Tab => ({
  id,
  path,
  history: [path],
  historyIndex: 0,
  isPinned,
  title,
  pageType,
});

export const navigateInTab = (tab: Tab, newPath: string): Tab => {
  if (newPath === tab.path) {
    return tab;
  }

  // Truncate forward history when navigating from middle of history
  const truncatedHistory = tab.history.slice(0, tab.historyIndex + 1);

  return {
    ...tab,
    path: newPath,
    history: [...truncatedHistory, newPath],
    historyIndex: truncatedHistory.length,
    // Clear cached metadata so useTabMeta fetches fresh data for new path
    title: undefined,
    pageType: undefined,
  };
};

export const goBack = (tab: Tab): Tab => {
  if (!canGoBack(tab)) {
    return tab;
  }

  const newIndex = tab.historyIndex - 1;
  return {
    ...tab,
    path: tab.history[newIndex],
    historyIndex: newIndex,
    // Clear cached metadata so useTabMeta fetches fresh data for navigated path
    title: undefined,
    pageType: undefined,
  };
};

export const goForward = (tab: Tab): Tab => {
  if (!canGoForward(tab)) {
    return tab;
  }

  const newIndex = tab.historyIndex + 1;
  return {
    ...tab,
    path: tab.history[newIndex],
    historyIndex: newIndex,
    // Clear cached metadata so useTabMeta fetches fresh data for navigated path
    title: undefined,
    pageType: undefined,
  };
};

export const canGoBack = (tab: Tab): boolean => tab.historyIndex > 0;

export const canGoForward = (tab: Tab): boolean => tab.historyIndex < tab.history.length - 1;

export const updateTabMeta = (tab: Tab, meta: TabMetaUpdate): Tab => ({
  ...tab,
  title: meta.title ?? tab.title,
  pageType: meta.pageType ?? tab.pageType,
});
