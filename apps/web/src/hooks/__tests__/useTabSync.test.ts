/**
 * useTabSync Tests
 * Tests for syncing URL navigation with browser-style tabs
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTabSync } from '../useTabSync';
import { useTabsStore } from '@/stores/useTabsStore';

// Mock next/navigation
const mockPathname = vi.fn(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
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
    });
    mockLocalStorage.clear();
    mockPathname.mockReturnValue('/dashboard');
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
});
