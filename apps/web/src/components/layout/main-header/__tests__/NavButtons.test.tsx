import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import NavButtons from '../NavButtons';
import { useTabsStore } from '@/stores/useTabsStore';

const mockPush = vi.fn();

// Mock localStorage for Zustand persist
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

describe('NavButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
    useTabsStore.setState({
      tabs: [],
      activeTabId: null,
      rehydrated: true,
    });
    mockLocalStorage.clear();
  });

  describe('rendering', () => {
    it('given component renders, should display both navigation buttons with aria-labels', () => {
      render(<NavButtons />);

      expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go forward' })).toBeInTheDocument();
    });
  });

  describe('disabled states', () => {
    it('given no active tab, should disable both buttons', () => {
      render(<NavButtons />);

      expect(screen.getByRole('button', { name: 'Go back' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go forward' })).toBeDisabled();
    });

    it('given tab at start of history, should disable back button', () => {
      useTabsStore.getState().createTab({ path: '/page-1' });

      render(<NavButtons />);

      expect(screen.getByRole('button', { name: 'Go back' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go forward' })).toBeDisabled();
    });

    it('given tab with back history, should enable back button', () => {
      useTabsStore.getState().createTab({ path: '/page-1' });
      useTabsStore.getState().navigateInActiveTab('/page-2');

      render(<NavButtons />);

      expect(screen.getByRole('button', { name: 'Go back' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Go forward' })).toBeDisabled();
    });

    it('given tab with forward history, should enable forward button', () => {
      useTabsStore.getState().createTab({ path: '/page-1' });
      useTabsStore.getState().navigateInActiveTab('/page-2');
      useTabsStore.getState().goBackInActiveTab();

      render(<NavButtons />);

      expect(screen.getByRole('button', { name: 'Go back' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go forward' })).toBeEnabled();
    });
  });

  describe('navigation', () => {
    it('given back click, should navigate to previous path', async () => {
      const user = userEvent.setup();
      useTabsStore.getState().createTab({ path: '/dashboard' });
      useTabsStore.getState().navigateInActiveTab('/dashboard/drive-1/page-1');

      render(<NavButtons />);
      await user.click(screen.getByRole('button', { name: 'Go back' }));

      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });

    it('given forward click, should navigate to next path', async () => {
      const user = userEvent.setup();
      useTabsStore.getState().createTab({ path: '/dashboard' });
      useTabsStore.getState().navigateInActiveTab('/dashboard/drive-1/page-1');
      useTabsStore.getState().goBackInActiveTab();

      render(<NavButtons />);
      await user.click(screen.getByRole('button', { name: 'Go forward' }));

      expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/page-1');
    });

    it('given back click, should update store historyIndex', async () => {
      const user = userEvent.setup();
      useTabsStore.getState().createTab({ path: '/dashboard' });
      useTabsStore.getState().navigateInActiveTab('/dashboard/drive-1/page-1');

      render(<NavButtons />);
      await user.click(screen.getByRole('button', { name: 'Go back' }));

      const tab = useTabsStore.getState().tabs[0];
      expect(tab.historyIndex).toBe(0);
      expect(tab.path).toBe('/dashboard');
    });

    it('given forward click, should update store historyIndex', async () => {
      const user = userEvent.setup();
      useTabsStore.getState().createTab({ path: '/dashboard' });
      useTabsStore.getState().navigateInActiveTab('/dashboard/drive-1/page-1');
      useTabsStore.getState().goBackInActiveTab();

      render(<NavButtons />);
      await user.click(screen.getByRole('button', { name: 'Go forward' }));

      const tab = useTabsStore.getState().tabs[0];
      expect(tab.historyIndex).toBe(1);
      expect(tab.path).toBe('/dashboard/drive-1/page-1');
    });
  });
});
