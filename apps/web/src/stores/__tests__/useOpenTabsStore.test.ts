/**
 * useOpenTabsStore Tests
 * Tests for VS Code-style tab management including open, close, pin, and navigation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useOpenTabsStore, selectTabCount, selectHasMultipleTabs, selectActiveTab } from '../useOpenTabsStore';
import type { Tab } from '../useOpenTabsStore';

// Mock localStorage for persistence tests
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

// Test factory for creating tabs
const createTestTab = (overrides: Partial<Omit<Tab, 'isPinned'>> = {}): Omit<Tab, 'isPinned'> => ({
  id: overrides.id ?? 'page-1',
  driveId: overrides.driveId ?? 'drive-1',
  title: overrides.title ?? 'Test Page',
  type: overrides.type ?? 'DOCUMENT',
});

describe('useOpenTabsStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useOpenTabsStore.setState({
      tabs: [],
      activeTabId: null,
      rehydrated: true,
    });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty tabs array', () => {
      const { tabs } = useOpenTabsStore.getState();
      expect(tabs).toEqual([]);
    });

    it('given store is created, should have null activeTabId', () => {
      const { activeTabId } = useOpenTabsStore.getState();
      expect(activeTabId).toBeNull();
    });
  });

  describe('openTab', () => {
    it('given no existing tabs, should add tab and set as active', () => {
      const { openTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].id).toBe('page-1');
      expect(state.activeTabId).toBe('page-1');
    });

    it('given new tab opened, should set isPinned to false', () => {
      const { openTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));

      expect(useOpenTabsStore.getState().tabs[0].isPinned).toBe(false);
    });

    it('given existing tab opened, should activate without duplicating', () => {
      const { openTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-1' })); // Re-open first tab

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe('page-1');
    });

    it('given active tab exists, should insert new tab after active tab', () => {
      const { openTab, setActiveTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));

      // Activate page-1, then open a new page
      setActiveTab('page-1');
      openTab(createTestTab({ id: 'page-4' }));

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs.map(t => t.id)).toEqual(['page-1', 'page-4', 'page-2', 'page-3']);
    });
  });

  describe('openTabInBackground', () => {
    it('given new tab opened in background, should not change active tab', () => {
      const { openTab, openTabInBackground } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTabInBackground(createTestTab({ id: 'page-2' }));

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe('page-1'); // Still active
    });

    it('given existing tab opened in background, should not duplicate or change active', () => {
      const { openTab, openTabInBackground } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTabInBackground(createTestTab({ id: 'page-1' }));

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe('page-2');
    });
  });

  describe('closeTab', () => {
    it('given active tab closed with tabs to the right, should activate next tab', () => {
      const { openTab, closeTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      useOpenTabsStore.setState({ activeTabId: 'page-2' });

      closeTab('page-2');

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe('page-3'); // Next tab takes over
    });

    it('given last tab closed, should activate new last tab', () => {
      const { openTab, closeTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      // page-3 is active (last opened)

      closeTab('page-3');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-2');
    });

    it('given only tab closed, should set activeTabId to null', () => {
      const { openTab, closeTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      closeTab('page-1');

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(0);
      expect(state.activeTabId).toBeNull();
    });

    it('given inactive tab closed, should not change active tab', () => {
      const { openTab, closeTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      // page-3 is active

      closeTab('page-1');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-3');
    });

    it('given non-existent tab, should do nothing', () => {
      const { openTab, closeTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));

      closeTab('non-existent');

      expect(useOpenTabsStore.getState().tabs).toHaveLength(1);
    });
  });

  describe('closeOtherTabs', () => {
    it('given multiple tabs, should keep only specified tab', () => {
      const { openTab, closeOtherTabs } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));

      closeOtherTabs('page-2');

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].id).toBe('page-2');
      expect(state.activeTabId).toBe('page-2');
    });

    it('given pinned tabs exist, should keep pinned tabs and specified tab', () => {
      const { openTab, pinTab, closeOtherTabs } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      pinTab('page-1');

      closeOtherTabs('page-3');

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs).toHaveLength(2);
      expect(tabs.map(t => t.id)).toContain('page-1');
      expect(tabs.map(t => t.id)).toContain('page-3');
    });
  });

  describe('closeTabsToRight', () => {
    it('given tabs to the right, should close them', () => {
      const { openTab, closeTabsToRight } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      openTab(createTestTab({ id: 'page-4' }));

      closeTabsToRight('page-2');

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs.map(t => t.id)).toEqual(['page-1', 'page-2']);
    });

    it('given active tab was to the right, should activate reference tab', () => {
      const { openTab, closeTabsToRight } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      // page-3 is active

      closeTabsToRight('page-1');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });

    it('given pinned tabs to the right, should preserve them', () => {
      const { openTab, pinTab, closeTabsToRight } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      pinTab('page-3'); // Pinned tabs move to front

      // After pinning, order is: page-3(pinned), page-1, page-2
      closeTabsToRight('page-1');

      const tabs = useOpenTabsStore.getState().tabs;
      // Should keep page-3 (pinned, at front) and page-1
      expect(tabs.map(t => t.id)).toEqual(['page-3', 'page-1']);
    });
  });

  describe('closeAllTabs', () => {
    it('given no pinned tabs, should close all tabs', () => {
      const { openTab, closeAllTabs } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));

      closeAllTabs();

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(0);
      expect(state.activeTabId).toBeNull();
    });

    it('given pinned tabs exist, should keep only pinned tabs', () => {
      const { openTab, pinTab, closeAllTabs } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      pinTab('page-2');

      closeAllTabs();

      const state = useOpenTabsStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].id).toBe('page-2');
      expect(state.activeTabId).toBe('page-2');
    });
  });

  describe('setActiveTab', () => {
    it('given valid tab id, should set as active', () => {
      const { openTab, setActiveTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));

      setActiveTab('page-1');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });

    it('given non-existent tab id, should not change active tab', () => {
      const { openTab, setActiveTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));

      setActiveTab('non-existent');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });
  });

  describe('setActiveTabByIndex', () => {
    it('given valid index, should set tab at that index as active', () => {
      const { openTab, setActiveTabByIndex } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));

      setActiveTabByIndex(0);

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });

    it('given out of bounds index, should not change active tab', () => {
      const { openTab, setActiveTabByIndex } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));

      setActiveTabByIndex(5);

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });

    it('given negative index, should not change active tab', () => {
      const { openTab, setActiveTabByIndex } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));

      setActiveTabByIndex(-1);

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });
  });

  describe('cycleTab', () => {
    it('given next direction, should activate next tab', () => {
      const { openTab, setActiveTab, cycleTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      setActiveTab('page-1');

      cycleTab('next');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-2');
    });

    it('given prev direction, should activate previous tab', () => {
      const { openTab, setActiveTab, cycleTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      setActiveTab('page-2');

      cycleTab('prev');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });

    it('given at last tab with next direction, should wrap to first', () => {
      const { openTab, cycleTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      // page-3 is active (last opened)

      cycleTab('next');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });

    it('given at first tab with prev direction, should wrap to last', () => {
      const { openTab, setActiveTab, cycleTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      setActiveTab('page-1');

      cycleTab('prev');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-3');
    });

    it('given only one tab, should not change active tab', () => {
      const { openTab, cycleTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));

      cycleTab('next');

      expect(useOpenTabsStore.getState().activeTabId).toBe('page-1');
    });
  });

  describe('reorderTab', () => {
    it('given valid indices, should move tab to new position', () => {
      const { openTab, reorderTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));

      reorderTab(2, 0); // Move page-3 to first position

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs.map(t => t.id)).toEqual(['page-3', 'page-1', 'page-2']);
    });

    it('given same indices, should not change order', () => {
      const { openTab, reorderTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));

      reorderTab(0, 0);

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs.map(t => t.id)).toEqual(['page-1', 'page-2']);
    });

    it('given invalid fromIndex, should not change order', () => {
      const { openTab, reorderTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));

      reorderTab(-1, 0);
      reorderTab(10, 0);

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs.map(t => t.id)).toEqual(['page-1', 'page-2']);
    });
  });

  describe('pinTab', () => {
    it('given unpinned tab, should set isPinned to true', () => {
      const { openTab, pinTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      pinTab('page-1');

      expect(useOpenTabsStore.getState().tabs[0].isPinned).toBe(true);
    });

    it('given tab pinned, should move it to front of tabs', () => {
      const { openTab, pinTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));

      pinTab('page-3');

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs[0].id).toBe('page-3');
      expect(tabs[0].isPinned).toBe(true);
    });

    it('given multiple tabs pinned, should group pinned tabs at front', () => {
      const { openTab, pinTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));
      openTab(createTestTab({ id: 'page-3' }));
      openTab(createTestTab({ id: 'page-4' }));

      pinTab('page-2');
      pinTab('page-4');

      const tabs = useOpenTabsStore.getState().tabs;
      expect(tabs[0].isPinned).toBe(true);
      expect(tabs[1].isPinned).toBe(true);
      expect(tabs[2].isPinned).toBe(false);
      expect(tabs[3].isPinned).toBe(false);
    });
  });

  describe('unpinTab', () => {
    it('given pinned tab, should set isPinned to false', () => {
      const { openTab, pinTab, unpinTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      pinTab('page-1');
      unpinTab('page-1');

      expect(useOpenTabsStore.getState().tabs[0].isPinned).toBe(false);
    });

    it('given non-existent tab, should not throw', () => {
      const { unpinTab } = useOpenTabsStore.getState();

      expect(() => unpinTab('non-existent')).not.toThrow();
    });
  });

  describe('updateTabTitle', () => {
    it('given valid tab, should update title', () => {
      const { openTab, updateTabTitle } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1', title: 'Original' }));
      updateTabTitle('page-1', 'Updated Title');

      expect(useOpenTabsStore.getState().tabs[0].title).toBe('Updated Title');
    });

    it('given non-existent tab, should not throw', () => {
      const { updateTabTitle } = useOpenTabsStore.getState();

      expect(() => updateTabTitle('non-existent', 'Title')).not.toThrow();
    });
  });

  describe('selectors', () => {
    it('selectTabCount should return number of tabs', () => {
      const { openTab } = useOpenTabsStore.getState();

      openTab(createTestTab({ id: 'page-1' }));
      openTab(createTestTab({ id: 'page-2' }));

      expect(selectTabCount(useOpenTabsStore.getState())).toBe(2);
    });

    it('selectHasMultipleTabs should return true when more than one tab', () => {
      const { openTab } = useOpenTabsStore.getState();

      expect(selectHasMultipleTabs(useOpenTabsStore.getState())).toBe(false);

      openTab(createTestTab({ id: 'page-1' }));
      expect(selectHasMultipleTabs(useOpenTabsStore.getState())).toBe(false);

      openTab(createTestTab({ id: 'page-2' }));
      expect(selectHasMultipleTabs(useOpenTabsStore.getState())).toBe(true);
    });

    it('selectActiveTab should return active tab or null', () => {
      const { openTab } = useOpenTabsStore.getState();

      expect(selectActiveTab(useOpenTabsStore.getState())).toBeNull();

      openTab(createTestTab({ id: 'page-1', title: 'Test Page' }));
      const activeTab = selectActiveTab(useOpenTabsStore.getState());
      expect(activeTab?.id).toBe('page-1');
      expect(activeTab?.title).toBe('Test Page');
    });
  });
});
