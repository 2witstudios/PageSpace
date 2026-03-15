import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { createCSRFHook } from '../createCSRFHook';

describe('createCSRFHook', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return a hook function when called with an endpoint', () => {
    const hook = createCSRFHook('/api/test-csrf');
    expect(typeof hook).toBe('function');
  });

  describe('returned hook', () => {
    const useTestCSRF = createCSRFHook('/api/test-csrf');

    it('should fetch the CSRF token on mount', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ csrfToken: 'test-token-abc' }),
      });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/test-csrf', {
        credentials: 'include',
      });
      expect(result.current.csrfToken).toBe('test-token-abc');
      expect(result.current.error).toBeNull();
    });

    it('should set isLoading to true initially', () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // never resolves

      const { result } = renderHook(() => useTestCSRF());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.csrfToken).toBeNull();
    });

    it('should handle a successful fetch response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ csrfToken: 'valid-token-123' }),
      });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBe('valid-token-123');
      expect(result.current.error).toBeNull();
    });

    it('should handle fetch failure (non-ok response)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBeNull();
      expect(result.current.error).toBe('Failed to fetch CSRF token');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle network error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBeNull();
      expect(result.current.error).toBe('Network error');

      consoleSpy.mockRestore();
    });

    it('should handle invalid response (missing csrfToken field)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ someOtherField: 'value' }),
      });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBeNull();
      expect(result.current.error).toBe('Invalid CSRF token response');

      consoleSpy.mockRestore();
    });

    it('should handle invalid response (csrfToken is not a string)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ csrfToken: 12345 }),
      });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBeNull();
      expect(result.current.error).toBe('Invalid CSRF token response');

      consoleSpy.mockRestore();
    });

    it('should handle invalid response (csrfToken is empty string)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ csrfToken: '' }),
      });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBeNull();
      expect(result.current.error).toBe('Invalid CSRF token response');

      consoleSpy.mockRestore();
    });

    it('should handle invalid response (null body)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => null,
      });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBeNull();
      expect(result.current.error).toBe('Invalid CSRF token response');

      consoleSpy.mockRestore();
    });

    it('should re-fetch the token when refreshToken is called', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ csrfToken: 'first-token' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ csrfToken: 'second-token' }),
        });

      const { result } = renderHook(() => useTestCSRF());

      // Wait for initial fetch
      await waitFor(() => {
        expect(result.current.csrfToken).toBe('first-token');
      });

      // Call refreshToken
      let refreshResult: string | null = null;
      await act(async () => {
        refreshResult = await result.current.refreshToken();
      });

      expect(refreshResult).toBe('second-token');
      expect(result.current.csrfToken).toBe('second-token');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return null from refreshToken when refresh fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ csrfToken: 'initial-token' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.csrfToken).toBe('initial-token');
      });

      let refreshResult: string | null = null;
      await act(async () => {
        refreshResult = await result.current.refreshToken();
      });

      expect(refreshResult).toBeNull();
      expect(result.current.csrfToken).toBeNull();

      consoleSpy.mockRestore();
    });

    it('should use the correct endpoint passed to the factory', async () => {
      const customHook = createCSRFHook('/api/custom/csrf-endpoint');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ csrfToken: 'custom-token' }),
      });

      renderHook(() => customHook());

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/custom/csrf-endpoint', {
          credentials: 'include',
        });
      });
    });

    it('should handle non-Error exceptions in catch block', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockRejectedValueOnce('string error');

      const { result } = renderHook(() => useTestCSRF());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.csrfToken).toBeNull();
      expect(result.current.error).toBe('Failed to fetch CSRF token');

      consoleSpy.mockRestore();
    });
  });
});
