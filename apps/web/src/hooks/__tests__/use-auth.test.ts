/**
 * useAuth Hook Tests
 * Tests for authentication hook integration with auth store
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Create hoisted mocks
const {
  mockPush,
  mockPost,
  mockClearJWTCache,
  mockGetOrCreateDeviceId,
  mockGetDeviceName,
  mockRefreshToken,
  mockStartTokenRefresh,
  mockStopTokenRefresh,
  mockAuthStore,
  mockLoadSession,
  mockIsSessionExpired,
  mockGetSessionDuration,
  mockShouldLoadSession,
  mockInitializeEventListeners,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockPost: vi.fn(),
  mockClearJWTCache: vi.fn(),
  mockGetOrCreateDeviceId: vi.fn(() => 'device-123'),
  mockGetDeviceName: vi.fn(() => 'Test Device'),
  mockRefreshToken: vi.fn(),
  mockStartTokenRefresh: vi.fn(),
  mockStopTokenRefresh: vi.fn(),
  mockAuthStore: {
    user: null as { id: string; name: string; email: string } | null,
    isLoading: false,
    isAuthenticated: false,
    isRefreshing: false,
    hasHydrated: true,
    setUser: vi.fn(),
    setLoading: vi.fn(),
    setHydrated: vi.fn(),
    startSession: vi.fn(),
    endSession: vi.fn(),
    updateActivity: vi.fn(),
  },
  mockLoadSession: vi.fn(),
  mockIsSessionExpired: vi.fn(() => false),
  mockGetSessionDuration: vi.fn(() => 0),
  mockShouldLoadSession: vi.fn(() => false),
  mockInitializeEventListeners: vi.fn(),
}));

// Mock dependencies with hoisted mocks
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => mockPost(...args),
  clearJWTCache: () => mockClearJWTCache(),
}));

vi.mock('@/lib/analytics', () => ({
  getOrCreateDeviceId: () => mockGetOrCreateDeviceId(),
  getDeviceName: () => mockGetDeviceName(),
}));

vi.mock('@/hooks/use-token-refresh', () => ({
  useTokenRefresh: () => ({
    refreshToken: mockRefreshToken,
    startTokenRefresh: mockStartTokenRefresh,
    stopTokenRefresh: mockStopTokenRefresh,
  }),
}));

vi.mock('@/stores/auth-store', () => {
  const useAuthStoreMock = vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockAuthStore);
    }
    return mockAuthStore;
  });
  // Add getState as a static method (Zustand pattern)
  useAuthStoreMock.getState = () => mockAuthStore;

  return {
    useAuthStore: useAuthStoreMock,
    authStoreHelpers: {
      loadSession: mockLoadSession,
      isSessionExpired: mockIsSessionExpired,
      getSessionDuration: mockGetSessionDuration,
      shouldLoadSession: mockShouldLoadSession,
      initializeEventListeners: mockInitializeEventListeners,
    },
  };
});

// Import after mocks
import { useAuth } from '../use-auth';

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

// Mock fetch
const originalFetch = global.fetch;

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.clear();

    // Reset mock auth store state
    mockAuthStore.user = null;
    mockAuthStore.isLoading = false;
    mockAuthStore.isAuthenticated = false;
    mockAuthStore.isRefreshing = false;
    mockAuthStore.hasHydrated = true;

    // Reset fetch mock
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  describe('initial state', () => {
    it('given no user in store, should return unauthenticated state', () => {
      const { result } = renderHook(() => useAuth());

      expect(result.current.user).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
    });

    it('given user in store, should return authenticated state', () => {
      mockAuthStore.user = { id: 'user-123', name: 'Test User', email: 'test@example.com' };
      mockAuthStore.isAuthenticated = true;

      const { result } = renderHook(() => useAuth());

      expect(result.current.user).toEqual(mockAuthStore.user);
      expect(result.current.isAuthenticated).toBe(true);
    });

    it('given loading state, should return isLoading=true', () => {
      mockAuthStore.isLoading = true;

      const { result } = renderHook(() => useAuth());

      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('login', () => {
    it('given valid credentials, should call API and update store', async () => {
      const userData = { id: 'user-123', name: 'Test User', email: 'test@example.com' };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(userData),
      } as Response);

      const { result } = renderHook(() => useAuth());

      let loginResult;
      await act(async () => {
        loginResult = await result.current.actions.login('test@example.com', 'password123');
      });

      expect(loginResult).toEqual({ success: true });
      expect(mockAuthStore.setUser).toHaveBeenCalledWith(userData);
      expect(mockAuthStore.startSession).toHaveBeenCalled();
    });

    it('given invalid credentials, should return error', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Invalid credentials' }),
      } as Response);

      const { result } = renderHook(() => useAuth());

      let loginResult;
      await act(async () => {
        loginResult = await result.current.actions.login('test@example.com', 'wrongpassword');
      });

      expect(loginResult).toEqual({ success: false, error: 'Invalid credentials' });
    });

    it('given network error, should return generic error', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useAuth());

      let loginResult;
      await act(async () => {
        loginResult = await result.current.actions.login('test@example.com', 'password');
      });

      expect(loginResult).toEqual({ success: false, error: 'Network error. Please try again.' });
      consoleError.mockRestore();
    });

    it('should include device information in login request', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'user-123' }),
      } as Response);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.login('test@example.com', 'password');
      });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({
          body: expect.stringContaining('deviceId'),
        })
      );
    });

    it('given deviceToken returned, should store in localStorage', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'user-123', deviceToken: 'device-token-abc' }),
      } as Response);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.login('test@example.com', 'password');
      });

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('deviceToken', 'device-token-abc');
    });
  });

  describe('logout', () => {
    it('should call logout API and redirect to signin', async () => {
      mockPost.mockResolvedValue({ ok: true });
      mockAuthStore.user = { id: 'user-123', name: 'Test', email: 'test@example.com' };
      mockAuthStore.isAuthenticated = true;

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.logout();
      });

      expect(mockPost).toHaveBeenCalledWith('/api/auth/logout');
      expect(mockAuthStore.endSession).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/auth/signin');
    });

    it('given logout API fails, should still clear session', async () => {
      mockPost.mockRejectedValue(new Error('API error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.logout();
      });

      expect(mockAuthStore.endSession).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/auth/signin');
      consoleError.mockRestore();
    });

    it('should clear deviceToken from localStorage', async () => {
      mockPost.mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.logout();
      });

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('deviceToken');
    });
  });

  describe('refreshAuth', () => {
    it('given refresh succeeds, should reload session', async () => {
      mockRefreshToken.mockResolvedValue(true);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.refreshAuth();
      });

      expect(mockRefreshToken).toHaveBeenCalled();
      expect(mockLoadSession).toHaveBeenCalledWith(true);
    });

    it('given refresh fails, should logout', async () => {
      mockRefreshToken.mockResolvedValue(false);
      mockPost.mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.refreshAuth();
      });

      expect(mockAuthStore.endSession).toHaveBeenCalled();
    });
  });

  describe('checkAuth', () => {
    it('should call loadSession from helpers', async () => {
      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.checkAuth();
      });

      expect(mockLoadSession).toHaveBeenCalled();
    });

    it('given already loading, should skip auth check', async () => {
      mockAuthStore.isLoading = true;
      mockLoadSession.mockClear();

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.checkAuth();
      });

      expect(mockLoadSession).not.toHaveBeenCalled();
    });
  });

  describe('sessionDuration', () => {
    it('should return duration from helpers', () => {
      mockGetSessionDuration.mockReturnValue(60000);

      const { result } = renderHook(() => useAuth());

      expect(result.current.sessionDuration).toBe(60000);
    });
  });

  describe('legacy properties', () => {
    it('given not authenticated, should return isError', () => {
      mockAuthStore.isAuthenticated = false;
      mockAuthStore.isLoading = false;
      mockAuthStore.hasHydrated = true;

      const { result } = renderHook(() => useAuth());

      expect(result.current.isError).toBeInstanceOf(Error);
    });

    it('given authenticated, should not return isError', () => {
      mockAuthStore.isAuthenticated = true;

      const { result } = renderHook(() => useAuth());

      expect(result.current.isError).toBeUndefined();
    });

    it('should provide mutate as alias for checkAuth', () => {
      const { result } = renderHook(() => useAuth());

      expect(result.current.mutate).toBeDefined();
      expect(typeof result.current.mutate).toBe('function');
    });
  });

  describe('token refresh lifecycle', () => {
    it('given authenticated and hydrated, should start token refresh', async () => {
      mockAuthStore.isAuthenticated = true;
      mockAuthStore.user = { id: 'user-123', name: 'Test', email: 'test@example.com' };
      mockAuthStore.hasHydrated = true;

      renderHook(() => useAuth());

      await waitFor(() => {
        expect(mockStartTokenRefresh).toHaveBeenCalled();
      });
    });

    it('given unauthenticated from start, should not start token refresh', async () => {
      // Start unauthenticated
      mockAuthStore.isAuthenticated = false;
      mockAuthStore.user = null;
      mockAuthStore.hasHydrated = true;

      renderHook(() => useAuth());

      // Give time for effects to potentially run
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should NOT have called startTokenRefresh when not authenticated
      expect(mockStartTokenRefresh).not.toHaveBeenCalled();
    });
  });

  describe('event listener initialization', () => {
    it('should initialize event listeners on mount', () => {
      renderHook(() => useAuth());

      expect(mockInitializeEventListeners).toHaveBeenCalled();
    });
  });

  describe('hydration', () => {
    it('given not hydrated, should set hydrated on mount', () => {
      mockAuthStore.hasHydrated = false;

      renderHook(() => useAuth());

      expect(mockAuthStore.setHydrated).toHaveBeenCalledWith(true);
    });
  });
});
