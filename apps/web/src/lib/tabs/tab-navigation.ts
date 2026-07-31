/**
 * Tab Navigation Logic
 * Pure functions for browser-style tab navigation with per-tab history
 */

import type { PageType } from '@pagespace/lib/utils/enums';

export interface Tab {
  id: string;
  path: string;
  /** Raw query string, no leading `?`. `''` means none. */
  search: string;
  /** Full hrefs (`toHref` output), one per navigation step in this tab. */
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
  search?: string;
  isPinned?: boolean;
  title?: string;
  pageType?: PageType;
}

/** Combine a pathname and a raw query string (no leading `?`) into an href. */
export const toHref = (path: string, search: string): string => (search ? `${path}?${search}` : path);

/** Split an href produced by `toHref` back into its pathname and raw query string. */
export const fromHref = (href: string): { path: string; search: string } => {
  const qIndex = href.indexOf('?');
  return qIndex === -1
    ? { path: href, search: '' }
    : { path: href.slice(0, qIndex), search: href.slice(qIndex + 1) };
};

export interface TabMetaUpdate {
  title?: string;
  pageType?: PageType;
}

const generateId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const createTab = ({
  id = generateId(),
  path = '/dashboard',
  search = '',
  isPinned = false,
  title,
  pageType,
}: CreateTabOptions = {}): Tab => ({
  id,
  path,
  search,
  history: [toHref(path, search)],
  historyIndex: 0,
  isPinned,
  title,
  pageType,
});

export const navigateInTab = (tab: Tab, newPath: string, newSearch: string = ''): Tab => {
  if (newPath === tab.path && newSearch === tab.search) {
    return tab;
  }

  // Truncate forward history when navigating from middle of history
  const truncatedHistory = tab.history.slice(0, tab.historyIndex + 1);

  return {
    ...tab,
    path: newPath,
    search: newSearch,
    history: [...truncatedHistory, toHref(newPath, newSearch)],
    historyIndex: truncatedHistory.length,
    // Clear cached metadata so useTabMeta fetches fresh data for new path
    title: undefined,
    pageType: undefined,
  };
};

/**
 * Jump directly to an arbitrary position in this tab's own history — what a
 * real Back/Forward (of any distance, e.g. a long-press-selected entry
 * several steps away) resolves to once the destination href is found in
 * `history`. `goBack`/`goForward` are just this at a fixed ±1 step: this isn't
 * a re-push, it's how a URL change gets RECONCILED against history that
 * already contains it, rather than truncated and re-appended as a new entry
 * (which would silently discard real forward history). A no-op for an
 * out-of-range or already-current index.
 */
export const goToHistoryIndex = (tab: Tab, index: number): Tab => {
  if (index < 0 || index >= tab.history.length || index === tab.historyIndex) {
    return tab;
  }

  const { path, search } = fromHref(tab.history[index]);
  return {
    ...tab,
    path,
    search,
    historyIndex: index,
    // Clear cached metadata so useTabMeta fetches fresh data for navigated path
    title: undefined,
    pageType: undefined,
  };
};

export const goBack = (tab: Tab): Tab => goToHistoryIndex(tab, tab.historyIndex - 1);

export const goForward = (tab: Tab): Tab => goToHistoryIndex(tab, tab.historyIndex + 1);

export const canGoBack = (tab: Tab): boolean => tab.historyIndex > 0;

export const canGoForward = (tab: Tab): boolean => tab.historyIndex < tab.history.length - 1;

export const updateTabMeta = (tab: Tab, meta: TabMetaUpdate): Tab => ({
  ...tab,
  title: meta.title ?? tab.title,
  pageType: meta.pageType ?? tab.pageType,
});
