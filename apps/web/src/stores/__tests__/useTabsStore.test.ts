/**
 * useTabsStore Tests
 * Tests for browser-style tab management with per-tab navigation history
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTabsStore, migrateTabsStorage } from '../useTabsStore';

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

  describe('setActiveTabHistoryIndex', () => {
    it('given an index several steps away, should jump directly there without pushing a new entry', () => {
      const { createTab, navigateInActiveTab, setActiveTabHistoryIndex } = useTabsStore.getState();

      createTab({ path: '/page-1' });
      navigateInActiveTab('/page-2');
      navigateInActiveTab('/page-3');

      setActiveTabHistoryIndex(0);

      const tab = useTabsStore.getState().tabs[0];
      expect(tab.path).toBe('/page-1');
      expect(tab.historyIndex).toBe(0);
      expect(tab.history).toEqual(['/page-1', '/page-2', '/page-3']);
    });

    it('given no active tab, should do nothing', () => {
      const { setActiveTabHistoryIndex } = useTabsStore.getState();

      setActiveTabHistoryIndex(0);

      expect(useTabsStore.getState().tabs).toHaveLength(0);
    });
  });

  describe('migrateTabsStorage (v0 -> v1: backfills Tab.search)', () => {
    it('given a v0-shaped tab with no search field, should backfill an empty string', () => {
      const v0State = {
        activeTabId: 'tab-1',
        tabs: [
          { id: 'tab-1', path: '/dashboard/agents', history: ['/dashboard/agents'], historyIndex: 0, isPinned: false },
        ],
      };

      const migrated = migrateTabsStorage(v0State, 0);

      expect(migrated.tabs[0].search).toBe('');
      expect(migrated.activeTabId).toBe('tab-1');
    });

    it('given an already-v1 state, should pass it through unchanged', () => {
      const v1State = {
        activeTabId: 'tab-1',
        tabs: [
          { id: 'tab-1', path: '/dashboard/agents', search: 'session=a', history: ['/dashboard/agents?session=a'], historyIndex: 0, isPinned: false },
        ],
      };

      expect(migrateTabsStorage(v1State, 1)).toEqual(v1State);
    });

    it('given no persisted tabs at all, should not throw', () => {
      expect(migrateTabsStorage({ activeTabId: null }, 0)).toEqual({ activeTabId: null, tabs: [] });
    });

    // A hand-edited or partially-written `localStorage` blob is outside this
    // app's control. A `migrate` that throws leaves zustand's persist
    // rehydration promise rejected, `state?.setRehydrated()` never runs, and
    // `rehydrated` stays false forever — freezing the whole tab bar with no
    // visible error. These prove malformed shapes degrade to an empty tab
    // list instead.
    it('given a completely malformed persisted value (null), should fall back to an empty tab list', () => {
      expect(migrateTabsStorage(null, 0)).toEqual({ activeTabId: null, tabs: [] });
    });

    it('given a persisted value that is a primitive, not an object, should fall back to an empty tab list', () => {
      expect(migrateTabsStorage('corrupted', 0)).toEqual({ activeTabId: null, tabs: [] });
      expect(migrateTabsStorage(42, 1)).toEqual({ activeTabId: null, tabs: [] });
    });

    it('given tabs present but not an array, should fall back to an empty tab list rather than throw', () => {
      expect(migrateTabsStorage({ activeTabId: 'tab-1', tabs: 'not-an-array' }, 0)).toEqual({
        activeTabId: 'tab-1',
        tabs: [],
      });
    });

    it('given a non-string activeTabId, should fall back to null', () => {
      expect(migrateTabsStorage({ activeTabId: 12345, tabs: [] }, 1)).toEqual({ activeTabId: null, tabs: [] });
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
