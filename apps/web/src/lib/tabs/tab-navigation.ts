/**
 * Tab Navigation Logic
 * Pure functions for browser-style tab navigation with per-tab history
 */

export interface Tab {
  id: string;
  path: string;
  history: string[];
  historyIndex: number;
  isPinned: boolean;
}

export interface CreateTabOptions {
  id?: string;
  path?: string;
  isPinned?: boolean;
}

const generateId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const createTab = ({
  id = generateId(),
  path = '/dashboard',
  isPinned = false,
}: CreateTabOptions = {}): Tab => ({
  id,
  path,
  history: [path],
  historyIndex: 0,
  isPinned,
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
  };
};

export const canGoBack = (tab: Tab): boolean => tab.historyIndex > 0;

export const canGoForward = (tab: Tab): boolean => tab.historyIndex < tab.history.length - 1;
