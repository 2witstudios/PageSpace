/**
 * useTabsStore Tests
 * Tests for browser-style tab management with per-tab navigation history
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTabsStore } from '../useTabsStore';
import type { Tab } from '@/lib/tabs/tab-navigation';

// Mock localStorage
const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

Object.defineProperty(global, 'localStorage', { value: mockLocalStorage });

// Factory for test tabs
const createTestTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: overrides.id ?? 'tab-1',
  path: overrides.path ?? '/dashboard',
  history: overrides.history ?? ['/dashboard'],
  historyIndex: overrides.historyIndex ?? 0,
  isPinned: overrides.isPinned ?? false,
});

describe('useTabsStore', () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabs: [],
      activeTabId: null,
      rehydrated: true,
    });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  describe('createTab', () => {
    it('given no tabs exist, should create tab and set as active', () => {
      const { createTab } = useTabsStore.getState();

      createTab();

      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].path).toBe('/dashboard');
      expect(state.activeTabId).toBe(state.tabs[0].id);
    });

    it('given custom path, should create tab at that path', () => {
      const { createTab } = useTabsStore.getState();

      createTab({ path: '/dashboard/drive-1/page-1' });

      const tab = useTabsStore.getState().tabs[0];
      expect(tab.path).toBe('/dashboard/drive-1/page-1');
      expect(tab.history).toEqual(['/dashboard/drive-1/page-1']);
    });

    it('given existing tabs, should insert after active tab', () => {
      const { createTab, setActiveTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      createTab({ path: '/page-2' });
      createTab({ path: '/page-3' });

      // Activate first tab and create new one
      const tabs = useTabsStore.getState().tabs;
      setActiveTab(tabs[0].id);
      createTab({ path: '/page-new' });

      const updatedTabs = useTabsStore.getState().tabs;
      expect(updatedTabs[1].path).toBe('/page-new');
    });

    it('given activate=false, should not change active tab', () => {
      const { createTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      const firstTabId = useTabsStore.getState().activeTabId;

      createTab({ path: '/page-2', activate: false });

      expect(useTabsStore.getState().activeTabId).toBe(firstTabId);
    });
  });

  describe('navigateInTab', () => {
    it('given active tab, should update its path', () => {
      const { createTab, navigateInActiveTab } = useTabsStore.getState();

      createTab({ path: '/dashboard' });
      navigateInActiveTab('/dashboard/drive-1/page-1');

      const tab = useTabsStore.getState().tabs[0];
      expect(tab.path).toBe('/dashboard/drive-1/page-1');
      expect(tab.history).toEqual(['/dashboard', '/dashboard/drive-1/page-1']);
    });

    it('given specific tab id, should update that tab', () => {
      const { createTab, navigateInTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      const tabId = useTabsStore.getState().tabs[0].id;

      navigateInTab(tabId, '/page-2');

      const tab = useTabsStore.getState().tabs[0];
      expect(tab.path).toBe('/page-2');
    });

    it('given no active tab, should do nothing', () => {
      const { navigateInActiveTab } = useTabsStore.getState();

      navigateInActiveTab('/page-1');

      expect(useTabsStore.getState().tabs).toHaveLength(0);
    });
  });

  describe('goBack / goForward', () => {
    it('given tab with history, goBack should navigate to previous', () => {
      const { createTab, navigateInActiveTab, goBackInActiveTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      navigateInActiveTab('/page-2');
      navigateInActiveTab('/page-3');

      goBackInActiveTab();

      expect(useTabsStore.getState().tabs[0].path).toBe('/page-2');
    });

    it('given tab went back, goForward should navigate forward', () => {
      const { createTab, navigateInActiveTab, goBackInActiveTab, goForwardInActiveTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      navigateInActiveTab('/page-2');
      goBackInActiveTab();

      goForwardInActiveTab();

      expect(useTabsStore.getState().tabs[0].path).toBe('/page-2');
    });
  });

  describe('duplicateTab', () => {
    it('given existing tab, should create copy with same path', () => {
      const { createTab, navigateInActiveTab, duplicateTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      navigateInActiveTab('/page-2');
      const originalId = useTabsStore.getState().activeTabId!;

      duplicateTab(originalId);

      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.tabs[1].path).toBe('/page-2');
      expect(state.tabs[1].id).not.toBe(originalId);
    });
  });

  describe('closeTab', () => {
    it('given only tab closed, should create new tab at dashboard', () => {
      const { createTab, closeTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      const tabId = useTabsStore.getState().tabs[0].id;

      closeTab(tabId);

      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].path).toBe('/dashboard');
    });

    it('given multiple tabs, should activate adjacent tab', () => {
      const { createTab, closeTab, setActiveTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      createTab({ path: '/page-2' });
      createTab({ path: '/page-3' });

      const tabs = useTabsStore.getState().tabs;
      setActiveTab(tabs[1].id); // Activate middle tab
      closeTab(tabs[1].id);

      // Should activate the tab that took its place (page-3)
      const state = useTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.tabs.find(t => t.id === state.activeTabId)?.path).toBe('/page-3');
    });
  });

  describe('selectors', () => {
    it('selectActiveTab should return current active tab', () => {
      const { createTab, selectActiveTab } = useTabsStore.getState();

      createTab({ path: '/page-1' });

      const activeTab = selectActiveTab(useTabsStore.getState());
      expect(activeTab?.path).toBe('/page-1');
    });

    it('selectCanGoBack should return whether active tab can go back', () => {
      const { createTab, navigateInActiveTab, selectCanGoBack } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      expect(selectCanGoBack(useTabsStore.getState())).toBe(false);

      navigateInActiveTab('/page-2');
      expect(selectCanGoBack(useTabsStore.getState())).toBe(true);
    });

    it('selectCanGoForward should return whether active tab can go forward', () => {
      const { createTab, navigateInActiveTab, goBackInActiveTab, selectCanGoForward } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      navigateInActiveTab('/page-2');
      expect(selectCanGoForward(useTabsStore.getState())).toBe(false);

      goBackInActiveTab();
      expect(selectCanGoForward(useTabsStore.getState())).toBe(true);
    });
  });
});
