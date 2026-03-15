import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock external dependencies before imports
const mockFetchWithAuth = vi.fn();
const mockGetBackendProvider = vi.fn((p: string) => p);

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  getBackendProvider: (p: string) => mockGetBackendProvider(p),
}));

import { useProviderSettings } from '../useProviderSettings';

describe('useProviderSettings', () => {
  const mockProviderSettings = {
    currentProvider: 'google',
    currentModel: 'gemini-pro',
    providers: {
      pagespace: { isConfigured: true, hasApiKey: true },
      openrouter: { isConfigured: false, hasApiKey: false },
      google: { isConfigured: true, hasApiKey: true },
      openai: { isConfigured: false, hasApiKey: false },
      anthropic: { isConfigured: false, hasApiKey: false },
      glm: { isConfigured: true, hasApiKey: true },
    },
    isAnyProviderConfigured: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockProviderSettings),
    });
  });

  it('should start with isLoading true', () => {
    const { result } = renderHook(() => useProviderSettings());
    // On the first render the loading state is true
    expect(result.current.isLoading).toBe(true);
  });

  it('should fetch provider settings on mount and set state', async () => {
    const { result } = renderHook(() => useProviderSettings());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/ai/chat');
    expect(result.current.providerSettings).toEqual(mockProviderSettings);
    expect(result.current.selectedProvider).toBe('google');
    expect(result.current.selectedModel).toBe('gemini-pro');
    expect(result.current.isAnyProviderConfigured).toBe(true);
    expect(result.current.needsSetup).toBe(false);
  });

  it('given pageId, should include it in the fetch URL', async () => {
    const { result } = renderHook(() =>
      useProviderSettings({ pageId: 'page-42' })
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/ai/chat?pageId=page-42');
  });

  it('given fetch fails (not ok), should set isLoading to false without updating settings', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useProviderSettings());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.providerSettings).toBeNull();
    expect(result.current.selectedProvider).toBe('pagespace');
  });

  it('given fetch throws, should set isLoading to false', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useProviderSettings());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.providerSettings).toBeNull();
  });

  describe('isProviderConfigured', () => {
    it('given pagespace provider, should check pagespace config', async () => {
      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isProviderConfigured('pagespace')).toBe(true);
    });

    it('given glm provider, should check glm config', async () => {
      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isProviderConfigured('glm')).toBe(true);
    });

    it('given openrouter_free, should check openrouter config via getBackendProvider', async () => {
      mockGetBackendProvider.mockReturnValue('openrouter');

      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isProviderConfigured('openrouter_free')).toBe(false);
    });

    it('given google provider, should check google config via getBackendProvider', async () => {
      mockGetBackendProvider.mockReturnValue('google');

      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isProviderConfigured('google')).toBe(true);
    });

    it('given no provider settings loaded, should return false', () => {
      mockFetchWithAuth.mockResolvedValue({ ok: false });

      const { result } = renderHook(() => useProviderSettings());

      // Before settings load
      expect(result.current.isProviderConfigured('google')).toBe(false);
    });

    it('given unknown provider not in config, should return false', async () => {
      mockGetBackendProvider.mockReturnValue('nonexistent');

      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isProviderConfigured('nonexistent')).toBe(false);
    });
  });

  describe('needsSetup', () => {
    it('given no providers configured, should return true', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockProviderSettings,
            isAnyProviderConfigured: false,
          }),
      });

      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.needsSetup).toBe(true);
    });
  });

  describe('setSelectedProvider / setSelectedModel', () => {
    it('should allow setting selected provider', async () => {
      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.setSelectedProvider('anthropic');
      });

      expect(result.current.selectedProvider).toBe('anthropic');
    });

    it('should allow setting selected model', async () => {
      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.setSelectedModel('claude-3-opus');
      });

      expect(result.current.selectedModel).toBe('claude-3-opus');
    });
  });

  describe('refresh', () => {
    it('should re-fetch provider settings when called', async () => {
      const { result } = renderHook(() => useProviderSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
    });
  });
});
