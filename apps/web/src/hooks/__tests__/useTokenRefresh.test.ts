import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockPost = vi.hoisted(() => vi.fn());
const mockFetchWithAuth = vi.hoisted(() => vi.fn());
const mockRefreshAuthSession = vi.hoisted(() => vi.fn());
const mockClearSessionCache = vi.hoisted(() => vi.fn());
const mockMutate = vi.hoisted(() => vi.fn());
const mockPush = vi.hoisted(() => vi.fn());
const mockSetUser = vi.hoisted(() => vi.fn());
const mockClearFailedAttempts = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: mockPost,
  fetchWithAuth: mockFetchWithAuth,
  refreshAuthSession: mockRefreshAuthSession,
  clearSessionCache: mockClearSessionCache,
}));

vi.mock('swr', () => ({
  mutate: mockMutate,
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({
      setUser: mockSetUser,
      clearFailedAttempts: mockClearFailedAttempts,
    })),
  },
}));

describe('useTokenRefresh', () => {
  let useTokenRefreshModule: typeof import('../useTokenRefresh');

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    // Reset all mocks
    mockPost.mockReset();
    mockFetchWithAuth.mockReset();
    mockRefreshAuthSession.mockReset();
    mockClearSessionCache.mockReset();
    mockMutate.mockReset();
    mockPush.mockReset();
    mockSetUser.mockReset();
    mockClearFailedAttempts.mockReset();

    // Suppress console output
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Clear desktop detection
    delete (window as Record<string, unknown>).electron;

    useTokenRefreshModule = await import('../useTokenRefresh');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('refreshToken', () => {
    it('should call refreshAuthSession when refreshToken is invoked', async () => {
      mockRefreshAuthSession.mockResolvedValueOnce({ success: true, shouldLogout: false });
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user-1', name: 'Test User', email: 'test@example.com' }),
      });

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      let refreshResult: boolean | undefined;
      await act(async () => {
        refreshResult = await result.current.refreshToken();
      });

      expect(mockRefreshAuthSession).toHaveBeenCalled();
      expect(refreshResult).toBe(true);
    });

    it('should update user store on successful refresh', async () => {
      const userData = { id: 'user-1', name: 'Test User', email: 'test@example.com' };

      mockRefreshAuthSession.mockResolvedValueOnce({ success: true, shouldLogout: false });
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => userData,
      });

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      await act(async () => {
        await result.current.refreshToken();
      });

      expect(mockSetUser).toHaveBeenCalledWith(userData);
      expect(mockClearFailedAttempts).toHaveBeenCalled();
    });

    it('should dispatch auth:refreshed event on successful refresh', async () => {
      mockRefreshAuthSession.mockResolvedValueOnce({ success: true, shouldLogout: false });
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user-1' }),
      });

      const eventSpy = vi.fn();
      window.addEventListener('auth:refreshed', eventSpy);

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      await act(async () => {
        await result.current.refreshToken();
      });

      expect(eventSpy).toHaveBeenCalled();

      window.removeEventListener('auth:refreshed', eventSpy);
    });

    it('should call logout when shouldLogout is true', async () => {
      mockRefreshAuthSession.mockResolvedValueOnce({ success: false, shouldLogout: true });
      mockPost.mockResolvedValueOnce({});
      mockMutate.mockResolvedValueOnce(undefined);

      const eventSpy = vi.fn();
      window.addEventListener('auth:expired', eventSpy);

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      let refreshResult: boolean | undefined;
      await act(async () => {
        refreshResult = await result.current.refreshToken();
      });

      expect(refreshResult).toBe(false);
      expect(mockPost).toHaveBeenCalledWith('/api/auth/logout');
      expect(mockPush).toHaveBeenCalledWith('/auth/signin');
      expect(eventSpy).toHaveBeenCalled();

      window.removeEventListener('auth:expired', eventSpy);
    });

    it('should return false on retryable failure', async () => {
      mockRefreshAuthSession.mockResolvedValueOnce({ success: false, shouldLogout: false });

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      let refreshResult: boolean | undefined;
      await act(async () => {
        refreshResult = await result.current.refreshToken();
      });

      expect(refreshResult).toBe(false);
    });

    it('should return false when refreshAuthSession throws', async () => {
      mockRefreshAuthSession.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      let refreshResult: boolean | undefined;
      await act(async () => {
        refreshResult = await result.current.refreshToken();
      });

      expect(refreshResult).toBe(false);
    });

    it('should deduplicate concurrent refresh calls', async () => {
      // Make the refresh take some time
      mockRefreshAuthSession.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true, shouldLogout: false }), 100))
      );
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'user-1' }),
      });

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      let result1: boolean | undefined;
      let result2: boolean | undefined;

      await act(async () => {
        const promise1 = result.current.refreshToken();
        const promise2 = result.current.refreshToken();

        // Advance timers to resolve the promise
        vi.advanceTimersByTime(200);

        [result1, result2] = await Promise.all([promise1, promise2]);
      });

      // Both should succeed, but refreshAuthSession should only be called once
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(mockRefreshAuthSession).toHaveBeenCalledTimes(1);
    });

    it('should handle fetchWithAuth failure gracefully after successful refresh', async () => {
      mockRefreshAuthSession.mockResolvedValueOnce({ success: true, shouldLogout: false });
      mockFetchWithAuth.mockRejectedValueOnce(new Error('Fetch failed'));

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      let refreshResult: boolean | undefined;
      await act(async () => {
        refreshResult = await result.current.refreshToken();
      });

      // Should still return true since refreshAuthSession succeeded
      expect(refreshResult).toBe(true);
    });
  });

  describe('scheduleTokenRefresh', () => {
    it('should skip scheduled refresh for web (non-desktop)', async () => {
      delete (window as Record<string, unknown>).electron;

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      act(() => {
        result.current.startTokenRefresh();
      });

      // Should not have set up any timeouts for refresh
      // Advance past refresh time
      vi.advanceTimersByTime(15 * 60 * 1000);

      expect(mockRefreshAuthSession).not.toHaveBeenCalled();
    });

    it('should schedule refresh on desktop', async () => {
      // Set up desktop detection
      (window as Record<string, unknown>).electron = { isDesktop: true };

      // Re-import to pick up module-level globals reset
      vi.resetModules();
      useTokenRefreshModule = await import('../useTokenRefresh');

      mockRefreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'user-1' }),
      });

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      act(() => {
        result.current.startTokenRefresh();
      });

      // Default is 15 min - 3 min buffer = 12 minutes
      await act(async () => {
        vi.advanceTimersByTime(12 * 60 * 1000);
      });

      expect(mockRefreshAuthSession).toHaveBeenCalled();
    });
  });

  describe('startTokenRefresh / stopTokenRefresh', () => {
    it('should reset retry count when starting', async () => {
      (window as Record<string, unknown>).electron = { isDesktop: true };
      vi.resetModules();
      useTokenRefreshModule = await import('../useTokenRefresh');

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      // Start should not throw
      act(() => {
        result.current.startTokenRefresh();
      });

      // Stop should clean up
      act(() => {
        result.current.stopTokenRefresh();
      });

      // After stop, advancing timers should not trigger refresh
      vi.advanceTimersByTime(20 * 60 * 1000);

      expect(mockRefreshAuthSession).not.toHaveBeenCalled();
    });

    it('should clear all timeouts when stopTokenRefresh is called', async () => {
      (window as Record<string, unknown>).electron = { isDesktop: true };
      vi.resetModules();
      useTokenRefreshModule = await import('../useTokenRefresh');

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      act(() => {
        result.current.startTokenRefresh();
      });

      act(() => {
        result.current.stopTokenRefresh();
      });

      // Should not refresh after stopping
      await act(async () => {
        vi.advanceTimersByTime(15 * 60 * 1000);
      });

      expect(mockRefreshAuthSession).not.toHaveBeenCalled();
    });
  });

  describe('visibility change handler', () => {
    it('should refresh token when app becomes visible after long time', async () => {
      mockRefreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'user-1' }),
      });

      renderHook(() => useTokenRefreshModule.useTokenRefresh());

      // Simulate enough time passing (more than 12 minutes)
      vi.advanceTimersByTime(13 * 60 * 1000);

      // Simulate visibility change to visible
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(mockRefreshAuthSession).toHaveBeenCalled();
    });

    it('should not refresh when app becomes visible within short time', async () => {
      renderHook(() => useTokenRefreshModule.useTokenRefresh());

      // Simulate short time (less than 12 minutes)
      vi.advanceTimersByTime(5 * 60 * 1000);

      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(mockRefreshAuthSession).not.toHaveBeenCalled();
    });

    it('should not refresh when document becomes hidden', async () => {
      renderHook(() => useTokenRefreshModule.useTokenRefresh());

      vi.advanceTimersByTime(13 * 60 * 1000);

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true,
      });

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(mockRefreshAuthSession).not.toHaveBeenCalled();
    });
  });

  describe('isRefreshing state', () => {
    it('should set isRefreshing to false initially', () => {
      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());
      expect(result.current.isRefreshing).toBe(false);
    });

    it('should return isRefreshing as false after refresh completes', async () => {
      mockRefreshAuthSession.mockResolvedValueOnce({ success: true, shouldLogout: false });
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user-1' }),
      });

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      await act(async () => {
        await result.current.refreshToken();
      });

      expect(result.current.isRefreshing).toBe(false);
    });
  });

  describe('desktop logout', () => {
    it('should clear desktop auth and session cache when logging out on desktop', async () => {
      const mockClearAuth = vi.fn().mockResolvedValue(undefined);
      (window as Record<string, unknown>).electron = {
        isDesktop: true,
        auth: { clearAuth: mockClearAuth },
      };

      vi.resetModules();
      useTokenRefreshModule = await import('../useTokenRefresh');

      mockRefreshAuthSession.mockResolvedValueOnce({ success: false, shouldLogout: true });
      mockPost.mockResolvedValueOnce({});
      mockMutate.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      await act(async () => {
        await result.current.refreshToken();
      });

      expect(mockClearAuth).toHaveBeenCalled();
      expect(mockClearSessionCache).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/auth/signin');
    });
  });

  describe('return value', () => {
    it('should return all expected methods and state', () => {
      const { result } = renderHook(() => useTokenRefreshModule.useTokenRefresh());

      expect(result.current).toHaveProperty('startTokenRefresh');
      expect(result.current).toHaveProperty('stopTokenRefresh');
      expect(result.current).toHaveProperty('refreshToken');
      expect(result.current).toHaveProperty('isRefreshing');
      expect(typeof result.current.startTokenRefresh).toBe('function');
      expect(typeof result.current.stopTokenRefresh).toBe('function');
      expect(typeof result.current.refreshToken).toBe('function');
      expect(typeof result.current.isRefreshing).toBe('boolean');
    });
  });
});
