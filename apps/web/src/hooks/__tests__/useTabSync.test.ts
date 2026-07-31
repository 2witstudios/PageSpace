/**
 * useTabSync Tests
 * Tests for syncing URL navigation with browser-style tabs
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTabSync } from '../useTabSync';
import { useTabsStore } from '@/stores/useTabsStore';
import type { ElectronAPI } from '@/types/electron';

// Mock next/navigation
const mockPathname = vi.fn(() => '/dashboard');
const mockSearchParams = vi.fn(() => new URLSearchParams());
const mockRouterReplace = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useSearchParams: () => mockSearchParams(),
  useRouter: () => ({
    replace: mockRouterReplace,
  }),
  useParams: () => ({}),
}));

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

describe('useTabSync', () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabs: [],
      activeTabId: null,
      rehydrated: true,
      desktopRestoreAttempted: false,
    });
    mockLocalStorage.clear();
    mockPathname.mockReturnValue('/dashboard');
    mockSearchParams.mockReturnValue(new URLSearchParams());
    window.electron = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial load with no tabs', () => {
    it('given no tabs exist and rehydrated, should create tab from current path', async () => {
      mockPathname.mockReturnValue('/dashboard/drive-1/page-1');

      renderHook(() => useTabSync());

      await waitFor(() => {
        const state = useTabsStore.getState();
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].path).toBe('/dashboard/drive-1/page-1');
        expect(state.activeTabId).toBe(state.tabs[0].id);
      });
    });

    it('given not rehydrated, should not create tab', () => {
      useTabsStore.setState({ rehydrated: false });
      mockPathname.mockReturnValue('/dashboard/drive-1/page-1');

      renderHook(() => useTabSync());

      expect(useTabsStore.getState().tabs).toHaveLength(0);
    });
  });

  describe('navigation with existing tabs', () => {
    it('given active tab exists and path changes, should update active tab path', async () => {
      // Setup: create initial tab
      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard' });
      const tabId = useTabsStore.getState().activeTabId;

      mockPathname.mockReturnValue('/dashboard/drive-1/page-1');

      renderHook(() => useTabSync());

      await waitFor(() => {
        const state = useTabsStore.getState();
        expect(state.tabs).toHaveLength(1); // No new tab created
        expect(state.tabs[0].path).toBe('/dashboard/drive-1/page-1');
        expect(state.activeTabId).toBe(tabId); // Same tab
      });
    });

    it('given a Next navigation to a path with a query string, should store it on the active tab', async () => {
      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard/agents' });
      const tabId = useTabsStore.getState().activeTabId;

      mockPathname.mockReturnValue('/dashboard/agents');
      mockSearchParams.mockReturnValue(new URLSearchParams('session=abc&c=def'));

      renderHook(() => useTabSync());

      await waitFor(() => {
        const state = useTabsStore.getState();
        expect(state.tabs[0].path).toBe('/dashboard/agents');
        expect(state.tabs[0].search).toBe('session=abc&c=def');
        expect(state.activeTabId).toBe(tabId);
      });
    });

    it('given path matches active tab path, should not update history', async () => {
      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard/drive-1/page-1' });

      mockPathname.mockReturnValue('/dashboard/drive-1/page-1');

      renderHook(() => useTabSync());

      await waitFor(() => {
        const state = useTabsStore.getState();
        expect(state.tabs[0].history).toHaveLength(1); // No duplicate in history
      });
    });
  });

  describe('desktop bootstrap restore', () => {
    it('given desktop starts on /dashboard with active non-dashboard tab, should restore active tab path', async () => {
      window.electron = { isDesktop: true } as unknown as ElectronAPI;

      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard/drive-1/page-1' });
      mockPathname.mockReturnValue('/dashboard');

      renderHook(() => useTabSync());

      await waitFor(() => {
        expect(mockRouterReplace).toHaveBeenCalledWith('/dashboard/drive-1/page-1');
        const state = useTabsStore.getState();
        expect(state.tabs[0].path).toBe('/dashboard/drive-1/page-1');
      });
    });

    it('given desktop restore already attempted, should not restore again on re-render', async () => {
      window.electron = { isDesktop: true } as unknown as ElectronAPI;

      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard/drive-1/page-1' });
      mockPathname.mockReturnValue('/dashboard');

      const { rerender } = renderHook(() => useTabSync());

      await waitFor(() => {
        expect(mockRouterReplace).toHaveBeenCalledTimes(1);
      });

      // Re-render should not trigger another restore
      rerender();

      expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    });

    it('given settings->dashboard layout remount, should not restore back to settings', async () => {
      window.electron = { isDesktop: true } as unknown as ElectronAPI;

      const { createTab } = useTabsStore.getState();
      createTab({ path: '/settings/account' });
      mockPathname.mockReturnValue('/settings/account');

      const firstMount = renderHook(() => useTabSync());
      firstMount.unmount();

      mockPathname.mockReturnValue('/dashboard');
      renderHook(() => useTabSync());

      await waitFor(() => {
        expect(mockRouterReplace).not.toHaveBeenCalled();
      });

      const state = useTabsStore.getState();
      expect(state.tabs[0].path).toBe('/dashboard');
    });

    it('given desktop first run with no tabs, later navigating to /dashboard should not bounce', async () => {
      window.electron = { isDesktop: true } as unknown as ElectronAPI;

      // First run: no tabs, start at /dashboard
      mockPathname.mockReturnValue('/dashboard');
      const { rerender } = renderHook(() => useTabSync());

      await waitFor(() => {
        expect(useTabsStore.getState().tabs).toHaveLength(1);
      });

      // Simulate user navigating to a page (tab path updates)
      act(() => {
        useTabsStore.getState().navigateInActiveTab('/dashboard/drive-1/page-1');
      });
      mockPathname.mockReturnValue('/dashboard/drive-1/page-1');
      rerender();

      // Now user navigates back to /dashboard — should NOT bounce
      mockPathname.mockReturnValue('/dashboard');
      rerender();

      expect(mockRouterReplace).not.toHaveBeenCalled();
    });

    it('given desktop starts on a deep-link path (not /dashboard), should skip restore', async () => {
      window.electron = { isDesktop: true } as unknown as ElectronAPI;

      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard/drive-1/page-1' });
      mockPathname.mockReturnValue('/dashboard/drive-2/page-5');

      renderHook(() => useTabSync());

      // Should not call replace because pathname is not /dashboard
      expect(mockRouterReplace).not.toHaveBeenCalled();
    });
  });

  describe('history tracking', () => {
    it('given navigation within tab, should build history', async () => {
      const { createTab, navigateInActiveTab } = useTabsStore.getState();
      createTab({ path: '/dashboard' });

      // Simulate navigation
      act(() => {
        navigateInActiveTab('/dashboard/drive-1');
      });

      act(() => {
        navigateInActiveTab('/dashboard/drive-1/page-1');
      });

      const state = useTabsStore.getState();
      expect(state.tabs[0].history).toEqual([
        '/dashboard',
        '/dashboard/drive-1',
        '/dashboard/drive-1/page-1',
      ]);
      expect(state.tabs[0].historyIndex).toBe(2);
    });
  });

  describe('history reconciliation (Back/Forward, caught in review: chatgpt-codex-connector P2)', () => {
    it('given a query-only Back after two selections, should move the index back instead of appending a new entry', async () => {
      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard/agents' });

      mockPathname.mockReturnValue('/dashboard/agents');
      mockSearchParams.mockReturnValue(new URLSearchParams('session=a'));
      const { rerender } = renderHook(() => useTabSync());
      await waitFor(() => {
        expect(useTabsStore.getState().tabs[0].search).toBe('session=a');
      });

      mockSearchParams.mockReturnValue(new URLSearchParams('session=b'));
      rerender();
      await waitFor(() => {
        expect(useTabsStore.getState().tabs[0].search).toBe('session=b');
      });

      expect(useTabsStore.getState().tabs[0].history).toEqual([
        '/dashboard/agents',
        '/dashboard/agents?session=a',
        '/dashboard/agents?session=b',
      ]);
      expect(useTabsStore.getState().tabs[0].historyIndex).toBe(2);

      // What a native Back does (or a popstate replaying a raw `history.pushState`
      // entry Next's router never pushed itself, e.g. the Agents surface's
      // selection store): the address returns to one this tab already recorded.
      mockSearchParams.mockReturnValue(new URLSearchParams('session=a'));
      rerender();

      await waitFor(() => {
        const tab = useTabsStore.getState().tabs[0];
        expect(tab.search).toBe('session=a');
        expect(tab.historyIndex).toBe(1);
        // No new entry appended — the array is unchanged, just the index moved.
        expect(tab.history).toEqual([
          '/dashboard/agents',
          '/dashboard/agents?session=a',
          '/dashboard/agents?session=b',
        ]);
      });
    });

    it('given a query-only Forward back to the later entry, should move the index forward instead of appending', async () => {
      const { createTab } = useTabsStore.getState();
      createTab({ path: '/dashboard/agents' });

      mockPathname.mockReturnValue('/dashboard/agents');
      mockSearchParams.mockReturnValue(new URLSearchParams('session=a'));
      const { rerender } = renderHook(() => useTabSync());
      await waitFor(() => expect(useTabsStore.getState().tabs[0].search).toBe('session=a'));

      mockSearchParams.mockReturnValue(new URLSearchParams('session=b'));
      rerender();
      await waitFor(() => expect(useTabsStore.getState().tabs[0].search).toBe('session=b'));

      mockSearchParams.mockReturnValue(new URLSearchParams('session=a'));
      rerender();
      await waitFor(() => expect(useTabsStore.getState().tabs[0].historyIndex).toBe(1));

      mockSearchParams.mockReturnValue(new URLSearchParams('session=b'));
      rerender();

      await waitFor(() => {
        const tab = useTabsStore.getState().tabs[0];
        expect(tab.search).toBe('session=b');
        expect(tab.historyIndex).toBe(2);
        expect(tab.history).toEqual([
          '/dashboard/agents',
          '/dashboard/agents?session=a',
          '/dashboard/agents?session=b',
        ]);
      });
    });
  });
});
