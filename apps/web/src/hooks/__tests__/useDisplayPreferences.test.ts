/**
 * useDisplayPreferences Hook Tests
 *
 * Tests the SWR-based display preferences hook:
 * - Returns default preferences when no data
 * - Returns fetched data when available
 * - Optimistic update via updatePreference
 * - Error and loading states
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SWRResponse } from 'swr';

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
const mockPatch = vi.hoisted(() => vi.fn());
const mockUseSWR = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  patch: mockPatch,
}));

vi.mock('swr', () => ({
  default: mockUseSWR,
}));

import { useDisplayPreferences } from '../useDisplayPreferences';

describe('useDisplayPreferences', () => {
  const defaultPreferences = {
    showTokenCounts: false,
    showCodeToggle: false,
    defaultMarkdownMode: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return default preferences when no data is loaded', () => {
      const mockMutate = vi.fn();
      mockUseSWR.mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: true,
        mutate: mockMutate,
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      expect(result.current.preferences).toEqual(defaultPreferences);
      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeUndefined();
    });

    it('should pass the correct SWR key and options', () => {
      mockUseSWR.mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      renderHook(() => useDisplayPreferences());

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/settings/display-preferences',
        expect.any(Function),
        expect.objectContaining({
          revalidateOnFocus: false,
          dedupingInterval: 60000,
        })
      );
    });
  });

  describe('with fetched data', () => {
    it('should return fetched preferences when data is available', () => {
      const fetchedData = {
        showTokenCounts: true,
        showCodeToggle: true,
        defaultMarkdownMode: false,
      };
      mockUseSWR.mockReturnValue({
        data: fetchedData,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      expect(result.current.preferences).toEqual(fetchedData);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('error state', () => {
    it('should return error when SWR returns an error', () => {
      const error = new Error('Failed to fetch');
      mockUseSWR.mockReturnValue({
        data: undefined,
        error,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      expect(result.current.error).toBe(error);
      expect(result.current.preferences).toEqual(defaultPreferences);
    });
  });

  describe('updatePreference', () => {
    it('should perform optimistic update for SHOW_TOKEN_COUNTS', async () => {
      const mockMutate = vi.fn().mockResolvedValue(undefined);
      mockUseSWR.mockReturnValue({
        data: defaultPreferences,
        error: undefined,
        isLoading: false,
        mutate: mockMutate,
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      await act(async () => {
        await result.current.updatePreference('SHOW_TOKEN_COUNTS', true);
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          optimisticData: {
            ...defaultPreferences,
            showTokenCounts: true,
          },
          rollbackOnError: true,
          revalidate: false,
        })
      );
    });

    it('should perform optimistic update for SHOW_CODE_TOGGLE', async () => {
      const mockMutate = vi.fn().mockResolvedValue(undefined);
      mockUseSWR.mockReturnValue({
        data: defaultPreferences,
        error: undefined,
        isLoading: false,
        mutate: mockMutate,
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      await act(async () => {
        await result.current.updatePreference('SHOW_CODE_TOGGLE', true);
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          optimisticData: {
            ...defaultPreferences,
            showCodeToggle: true,
          },
        })
      );
    });

    it('should perform optimistic update for DEFAULT_MARKDOWN_MODE', async () => {
      const mockMutate = vi.fn().mockResolvedValue(undefined);
      mockUseSWR.mockReturnValue({
        data: defaultPreferences,
        error: undefined,
        isLoading: false,
        mutate: mockMutate,
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      await act(async () => {
        await result.current.updatePreference('DEFAULT_MARKDOWN_MODE', true);
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          optimisticData: {
            ...defaultPreferences,
            defaultMarkdownMode: true,
          },
        })
      );
    });

    it('should merge with existing data during optimistic update', async () => {
      const existingData = {
        showTokenCounts: true,
        showCodeToggle: false,
        defaultMarkdownMode: true,
      };
      const mockMutate = vi.fn().mockResolvedValue(undefined);
      mockUseSWR.mockReturnValue({
        data: existingData,
        error: undefined,
        isLoading: false,
        mutate: mockMutate,
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      await act(async () => {
        await result.current.updatePreference('SHOW_CODE_TOGGLE', true);
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          optimisticData: {
            showTokenCounts: true,
            showCodeToggle: true,
            defaultMarkdownMode: true,
          },
        })
      );
    });

    it('should call patch inside the mutate callback', async () => {
      mockPatch.mockResolvedValue(undefined);
      const mockMutate = vi.fn().mockImplementation(async (updater) => {
        if (typeof updater === 'function') {
          await updater();
        }
      });
      mockUseSWR.mockReturnValue({
        data: defaultPreferences,
        error: undefined,
        isLoading: false,
        mutate: mockMutate,
        isValidating: false,
      } as SWRResponse);

      const { result } = renderHook(() => useDisplayPreferences());

      await act(async () => {
        await result.current.updatePreference('SHOW_TOKEN_COUNTS', true);
      });

      expect(mockPatch).toHaveBeenCalledWith('/api/settings/display-preferences', {
        preferenceType: 'SHOW_TOKEN_COUNTS',
        enabled: true,
      });
    });
  });

  describe('SWR fetcher', () => {
    it('should use fetchWithAuth as the data fetcher', () => {
      mockUseSWR.mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      renderHook(() => useDisplayPreferences());

      // The fetcher is the second argument to useSWR
      const fetcher = mockUseSWR.mock.calls[0][1];
      expect(fetcher).toBeTypeOf('function');
    });

    it('should throw when fetchWithAuth returns non-ok response', async () => {
      mockUseSWR.mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      renderHook(() => useDisplayPreferences());

      const fetcher = mockUseSWR.mock.calls[0][1];

      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(fetcher('/api/settings/display-preferences')).rejects.toThrow(
        'Failed to fetch display preferences'
      );
    });

    it('should return parsed JSON when fetchWithAuth returns ok response', async () => {
      mockUseSWR.mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      renderHook(() => useDisplayPreferences());

      const fetcher = mockUseSWR.mock.calls[0][1];
      const mockData = { showTokenCounts: true, showCodeToggle: false, defaultMarkdownMode: false };

      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockData),
      });

      const result = await fetcher('/api/settings/display-preferences');
      expect(result).toEqual(mockData);
    });
  });
});
