/**
 * useAssistantSettingsStore Tests
 * Tests for centralized assistant settings management
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAssistantSettingsStore } from '../useAssistantSettingsStore';

// Mock fetchWithAuth
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

// Mock localStorage
const localStorageMock = {
  store: {} as Record<string, string>,
  getItem: vi.fn((key: string) => localStorageMock.store[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageMock.store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageMock.store[key];
  }),
  clear: vi.fn(() => {
    localStorageMock.store = {};
  }),
};

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock dispatchEvent
const mockDispatchEvent = vi.fn();
window.dispatchEvent = mockDispatchEvent;

describe('useAssistantSettingsStore', () => {
  beforeEach(() => {
    // Reset the store state before each test
    useAssistantSettingsStore.setState({
      showPageTree: false,
      currentProvider: null,
      currentModel: null,
      isAnyProviderConfigured: false,
      isLoading: false,
      isInitialized: false,
    });

    // Clear all mocks
    vi.clearAllMocks();
    localStorageMock.clear();

    // Default fetch mock
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({
        currentProvider: 'openai',
        currentModel: 'gpt-4',
        isAnyProviderConfigured: true,
      }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // Initial State Tests
  // ============================================
  describe('initial state', () => {
    it('should have showPageTree as false', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());
      expect(result.current.showPageTree).toBe(false);
    });

    it('should have currentProvider as null', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());
      expect(result.current.currentProvider).toBeNull();
    });

    it('should have currentModel as null', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());
      expect(result.current.currentModel).toBeNull();
    });

    it('should have isAnyProviderConfigured as false', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());
      expect(result.current.isAnyProviderConfigured).toBe(false);
    });

    it('should have isLoading as false', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());
      expect(result.current.isLoading).toBe(false);
    });

    it('should have isInitialized as false', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());
      expect(result.current.isInitialized).toBe(false);
    });
  });

  // ============================================
  // setShowPageTree Tests
  // ============================================
  describe('setShowPageTree', () => {
    it('should update showPageTree to true', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      act(() => {
        result.current.setShowPageTree(true);
      });

      expect(result.current.showPageTree).toBe(true);
    });

    it('should update showPageTree to false', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      act(() => {
        result.current.setShowPageTree(true);
      });
      expect(result.current.showPageTree).toBe(true);

      act(() => {
        result.current.setShowPageTree(false);
      });
      expect(result.current.showPageTree).toBe(false);
    });

    it('should persist to localStorage', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      act(() => {
        result.current.setShowPageTree(true);
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'pagespace:assistant:showPageTree',
        'true'
      );
    });

    it('should preserve other state when updating showPageTree', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      // Set up initial state
      useAssistantSettingsStore.setState({
        currentProvider: 'openai',
        currentModel: 'gpt-4',
        isAnyProviderConfigured: true,
      });

      act(() => {
        result.current.setShowPageTree(true);
      });

      expect(result.current.showPageTree).toBe(true);
      expect(result.current.currentProvider).toBe('openai');
      expect(result.current.currentModel).toBe('gpt-4');
      expect(result.current.isAnyProviderConfigured).toBe(true);
    });
  });

  // ============================================
  // setProviderSettings Tests
  // ============================================
  describe('setProviderSettings', () => {
    it('should update currentProvider and currentModel', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      act(() => {
        result.current.setProviderSettings('anthropic', 'claude-3');
      });

      expect(result.current.currentProvider).toBe('anthropic');
      expect(result.current.currentModel).toBe('claude-3');
    });

    it('should dispatch ai-settings-updated event', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      act(() => {
        result.current.setProviderSettings('google', 'gemini-pro');
      });

      expect(mockDispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai-settings-updated',
        })
      );
    });

    it('should preserve other state when updating provider settings', () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      // Set up initial state
      useAssistantSettingsStore.setState({
        showPageTree: true,
        isInitialized: true,
      });

      act(() => {
        result.current.setProviderSettings('openai', 'gpt-4');
      });

      expect(result.current.showPageTree).toBe(true);
      expect(result.current.isInitialized).toBe(true);
      expect(result.current.currentProvider).toBe('openai');
      expect(result.current.currentModel).toBe('gpt-4');
    });
  });

  // ============================================
  // loadSettings Tests
  // ============================================
  describe('loadSettings', () => {
    it('should fetch from /api/ai/settings', async () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/ai/settings');
    });

    it('should update state from API response', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({
          currentProvider: 'anthropic',
          currentModel: 'claude-3-opus',
          isAnyProviderConfigured: true,
        }),
      });

      const { result } = renderHook(() => useAssistantSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      expect(result.current.currentProvider).toBe('anthropic');
      expect(result.current.currentModel).toBe('claude-3-opus');
      expect(result.current.isAnyProviderConfigured).toBe(true);
    });

    it('should load showPageTree from localStorage', async () => {
      localStorageMock.store['pagespace:assistant:showPageTree'] = 'true';

      const { result } = renderHook(() => useAssistantSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      expect(result.current.showPageTree).toBe(true);
    });

    it('should set isAnyProviderConfigured from API', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({
          currentProvider: null,
          currentModel: null,
          isAnyProviderConfigured: false,
        }),
      });

      const { result } = renderHook(() => useAssistantSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      expect(result.current.isAnyProviderConfigured).toBe(false);
    });

    it('should set isInitialized to true after load', async () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      expect(result.current.isInitialized).toBe(false);

      await act(async () => {
        await result.current.loadSettings();
      });

      expect(result.current.isInitialized).toBe(true);
    });

    it('should set isLoading during fetch', async () => {
      let resolvePromise: () => void;
      const pendingPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });

      mockFetchWithAuth.mockReturnValue(
        pendingPromise.then(() => ({
          ok: true,
          json: async () => ({ currentProvider: 'openai', currentModel: 'gpt-4', isAnyProviderConfigured: true }),
        }))
      );

      const { result } = renderHook(() => useAssistantSettingsStore());

      // Start loading
      act(() => {
        result.current.loadSettings();
      });

      // Should be loading
      expect(result.current.isLoading).toBe(true);

      // Complete the fetch
      await act(async () => {
        resolvePromise!();
        await pendingPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should prevent duplicate loads when already loading', async () => {
      let resolvePromise: () => void;
      const pendingPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });

      mockFetchWithAuth.mockReturnValue(
        pendingPromise.then(() => ({
          ok: true,
          json: async () => ({ currentProvider: 'openai', currentModel: 'gpt-4', isAnyProviderConfigured: true }),
        }))
      );

      const { result } = renderHook(() => useAssistantSettingsStore());

      // Start first load
      act(() => {
        result.current.loadSettings();
      });

      // Try to start second load while first is in progress
      act(() => {
        result.current.loadSettings();
      });

      // Should only have been called once
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      // Clean up
      await act(async () => {
        resolvePromise!();
        await pendingPromise;
      });
    });

    it('should prevent duplicate loads when already initialized', async () => {
      const { result } = renderHook(() => useAssistantSettingsStore());

      // First load
      await act(async () => {
        await result.current.loadSettings();
      });

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      // Second load attempt
      await act(async () => {
        await result.current.loadSettings();
      });

      // Should still only have been called once
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    });

    it('should handle fetch failure gracefully', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useAssistantSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      // Should still be initialized (just without data)
      expect(result.current.isInitialized).toBe(true);
      expect(result.current.isLoading).toBe(false);
    });

    it('should handle non-OK response gracefully', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const { result } = renderHook(() => useAssistantSettingsStore());

      await act(async () => {
        await result.current.loadSettings();
      });

      // Should still be initialized (just without data)
      expect(result.current.isInitialized).toBe(true);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.currentProvider).toBeNull();
    });
  });
});
