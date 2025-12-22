/**
 * useAuth Hook Tests
 * Tests for authentication hook integration with auth store
 *
 * These tests validate observable behavior:
 * - Hook returns correct auth state from store
 * - Actions trigger appropriate state transitions
 * - Error states are properly exposed
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

type AuthUser = {
  id: string;
  name?: string;
  email?: string;
  deviceToken?: string;
};

type MockAuthStoreState = {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isRefreshing: boolean;
  hasHydrated: boolean;
  setUser: ReturnType<typeof vi.fn<(user: AuthUser | null) => void>>;
  setLoading: ReturnType<typeof vi.fn<(loading: boolean) => void>>;
  setHydrated: ReturnType<typeof vi.fn<(hydrated: boolean) => void>>;
  startSession: ReturnType<typeof vi.fn<() => void>>;
  endSession: ReturnType<typeof vi.fn<() => void>>;
  updateActivity: ReturnType<typeof vi.fn<() => void>>;
};

// Create hoisted mocks with state simulation
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
} = vi.hoisted(() => {
  const store: MockAuthStoreState = {
    user: null,
    isLoading: false,
    isAuthenticated: false,
    isRefreshing: false,
    hasHydrated: true,
    // Simulate actual state transitions
    setUser: vi.fn<(user: AuthUser | null) => void>((user) => {
      store.user = user;
      store.isAuthenticated = !!user;
    }),
    setLoading: vi.fn<(loading: boolean) => void>((loading) => {
      store.isLoading = loading;
    }),
    setHydrated: vi.fn<(hydrated: boolean) => void>((hydrated) => {
      store.hasHydrated = hydrated;
    }),
    startSession: vi.fn<() => void>(),
    endSession: vi.fn<() => void>(() => {
      store.user = null;
      store.isAuthenticated = false;
    }),
    updateActivity: vi.fn<() => void>(),
  };

  return {
    mockPush: vi.fn(),
    mockPost: vi.fn(),
    mockClearJWTCache: vi.fn(),
    mockGetOrCreateDeviceId: vi.fn(() => 'device-123'),
    mockGetDeviceName: vi.fn(() => 'Test Device'),
    mockRefreshToken: vi.fn(),
    mockStartTokenRefresh: vi.fn(),
    mockStopTokenRefresh: vi.fn(),
    mockAuthStore: store,
    mockLoadSession: vi.fn(),
    mockIsSessionExpired: vi.fn(() => false),
    mockGetSessionDuration: vi.fn(() => 0),
    mockShouldLoadSession: vi.fn(() => false),
    mockInitializeEventListeners: vi.fn(),
  };
});

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

vi.mock('@/stores/useAuthStore', () => {
  const useAuthStoreMock = vi.fn(<T,>(selector?: (s: typeof mockAuthStore) => T): T | typeof mockAuthStore => {
    if (typeof selector === 'function') {
      return selector(mockAuthStore);
    }
    return mockAuthStore;
  }) as unknown as {
    <T>(selector?: (s: typeof mockAuthStore) => T): T | typeof mockAuthStore;
    getState: () => typeof mockAuthStore;
  };
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
import { useAuth } from '../useAuth';

type UseAuthReturn = ReturnType<typeof useAuth>;
type LoginResult = Awaited<ReturnType<UseAuthReturn['actions']['login']>>;

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
Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage,
  configurable: true,
  writable: true,
});

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

    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  describe('initial state', () => {
    it('given no user in store, should return unauthenticated state', () => {
      const { result } = renderHook(() => useAuth());

      // Observable: hook exposes store state
      expect(result.current.user).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
    });

    it('given user in store, should return authenticated state', () => {
      const userData = { id: 'user-123', name: 'Test User', email: 'test@example.com' };
      mockAuthStore.user = userData;
      mockAuthStore.isAuthenticated = true;

      const { result } = renderHook(() => useAuth());

      // Observable: hook exposes stored user
      expect(result.current.user).toEqual(userData);
      expect(result.current.isAuthenticated).toBe(true);
    });

    it('given loading state, should return isLoading=true', () => {
      mockAuthStore.isLoading = true;

      const { result } = renderHook(() => useAuth());

      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('login', () => {
    it('given valid credentials, should update store with user and return success', async () => {
      const userData = { id: 'user-123', name: 'Test User', email: 'test@example.com' };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(userData),
      } as Response);

      const { result } = renderHook(() => useAuth());

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.actions.login('test@example.com', 'password123');
      });

      // Primary: observable return value
      expect(loginResult).toEqual({ success: true });
      // Primary: observable state change - user is now set
      expect(mockAuthStore.setUser).toHaveBeenCalledWith(userData);
      // Verify state transition occurred
      expect(mockAuthStore.user).toEqual(userData);
      expect(mockAuthStore.isAuthenticated).toBe(true);
    });

    it('given invalid credentials, should return error without changing auth state', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Invalid credentials' }),
      } as Response);

      const { result } = renderHook(() => useAuth());

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.actions.login('test@example.com', 'wrongpassword');
      });

      // Primary: observable error return
      expect(loginResult).toEqual({ success: false, error: 'Invalid credentials' });
      // Primary: state unchanged
      expect(mockAuthStore.user).toBeNull();
      expect(mockAuthStore.isAuthenticated).toBe(false);
    });

    it('given network error, should return generic error without changing auth state', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });

      const { result } = renderHook(() => useAuth());

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.actions.login('test@example.com', 'password');
      });

      // Primary: observable error return
      expect(loginResult).toEqual({ success: false, error: 'Network error. Please try again.' });
      // Primary: state unchanged
      expect(mockAuthStore.user).toBeNull();
      consoleError.mockRestore();
    });

    it('given deviceToken in response, should persist to localStorage', async () => {
      const userData = { id: 'user-123', deviceToken: 'device-token-abc' };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(userData),
      } as Response);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.login('test@example.com', 'password');
      });

      // Observable: deviceToken persisted
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('deviceToken', 'device-token-abc');
    });

    it('should include device information in login request body', async () => {
      // Mock both CSRF fetch (first call) and login fetch (second call)
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ csrfToken: 'test-csrf-token' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: 'user-123' }),
        } as Response);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.login('test@example.com', 'password');
      });

      // Observable: API called with correct payload (parse JSON for accurate assertion)
      // Note: calls[0] is CSRF token fetch, calls[1] is the login call
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const [, init] = vi.mocked(global.fetch).mock.calls[1] ?? [];
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        deviceId?: string;
        deviceName?: string;
      };
      expect(body.deviceId).toBe('device-123');
      expect(body.deviceName).toBe('Test Device');
    });
  });

  describe('logout', () => {
    it('should clear session and redirect to signin', async () => {
      // Setup authenticated state
      mockAuthStore.user = { id: 'user-123', name: 'Test', email: 'test@example.com' };
      mockAuthStore.isAuthenticated = true;
      mockPost.mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.logout();
      });

      // Primary: observable state transition
      expect(mockAuthStore.endSession).toHaveBeenCalled();
      expect(mockAuthStore.user).toBeNull();
      expect(mockAuthStore.isAuthenticated).toBe(false);
      // Primary: observable navigation
      expect(mockPush).toHaveBeenCalledWith('/auth/signin');
    });

    it('given logout API fails, should still clear session and redirect', async () => {
      mockPost.mockRejectedValue(new Error('API error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });

      mockAuthStore.user = { id: 'user-123', name: 'Test', email: 'test@example.com' };
      mockAuthStore.isAuthenticated = true;

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.logout();
      });

      // Primary: session cleared despite API failure (graceful degradation)
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

      // Observable: localStorage cleared
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('deviceToken');
    });
  });

  describe('refreshAuth', () => {
    it('given refresh succeeds, should trigger session reload', async () => {
      mockRefreshToken.mockResolvedValue(true);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.refreshAuth();
      });

      // Primary: session reload triggered with force=true
      expect(mockLoadSession).toHaveBeenCalledWith(true);
    });

    it('given refresh fails, should end session', async () => {
      mockRefreshToken.mockResolvedValue(false);
      mockPost.mockResolvedValue({ ok: true });

      mockAuthStore.user = { id: 'user-123', name: 'Test', email: 'test@example.com' };
      mockAuthStore.isAuthenticated = true;

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.refreshAuth();
      });

      // Primary: observable state transition - session ended
      expect(mockAuthStore.endSession).toHaveBeenCalled();
    });
  });

  describe('checkAuth', () => {
    it('given not loading, should trigger session load', async () => {
      mockAuthStore.isLoading = false;

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.checkAuth();
      });

      expect(mockLoadSession).toHaveBeenCalled();
    });

    it('given already loading, should skip redundant auth check', async () => {
      mockAuthStore.isLoading = true;
      mockLoadSession.mockClear();

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.actions.checkAuth();
      });

      // Observable: no redundant load when already loading
      expect(mockLoadSession).not.toHaveBeenCalled();
    });
  });

  describe('sessionDuration', () => {
    it('should expose session duration from helpers', () => {
      mockGetSessionDuration.mockReturnValue(60000);

      const { result } = renderHook(() => useAuth());

      // Observable: duration exposed
      expect(result.current.sessionDuration).toBe(60000);
    });
  });

  describe('error state (legacy compatibility)', () => {
    it('given not authenticated after hydration, should expose isError', () => {
      mockAuthStore.isAuthenticated = false;
      mockAuthStore.isLoading = false;
      mockAuthStore.hasHydrated = true;

      const { result } = renderHook(() => useAuth());

      // Observable: error state for unauthenticated users
      expect(result.current.isError).toBeInstanceOf(Error);
    });

    it('given authenticated, should not expose isError', () => {
      mockAuthStore.isAuthenticated = true;
      mockAuthStore.user = { id: 'user-123', name: 'Test', email: 'test@example.com' };

      const { result } = renderHook(() => useAuth());

      expect(result.current.isError).toBeUndefined();
    });

    it('should expose mutate as alias for checkAuth', () => {
      const { result } = renderHook(() => useAuth());

      expect(result.current.mutate).toBeDefined();
      expect(typeof result.current.mutate).toBe('function');
    });
  });

  describe('token refresh lifecycle', () => {
    // REVIEW: Token refresh timing depends on effect execution order and
    // may vary based on React version and strict mode. These tests verify
    // the refresh is scheduled when appropriate, not exact timing.
    it('given authenticated and hydrated, should schedule token refresh', async () => {
      mockAuthStore.isAuthenticated = true;
      mockAuthStore.user = { id: 'user-123', name: 'Test', email: 'test@example.com' };
      mockAuthStore.hasHydrated = true;

      renderHook(() => useAuth());

      await waitFor(() => {
        expect(mockStartTokenRefresh).toHaveBeenCalled();
      });
    });

    it('given unauthenticated, should not schedule token refresh', async () => {
      vi.useFakeTimers();
      mockAuthStore.isAuthenticated = false;
      mockAuthStore.user = null;
      mockAuthStore.hasHydrated = true;

      renderHook(() => useAuth());

      // Flush queued timers/effects deterministically
      await vi.runOnlyPendingTimersAsync();

      // Observable: no refresh scheduled for unauthenticated users
      expect(mockStartTokenRefresh).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('initialization', () => {
    it('should initialize event listeners on mount', () => {
      renderHook(() => useAuth());

      expect(mockInitializeEventListeners).toHaveBeenCalled();
    });

    it('given not hydrated, should mark as hydrated on mount', () => {
      mockAuthStore.hasHydrated = false;

      renderHook(() => useAuth());

      // Observable: hydration state updated
      expect(mockAuthStore.setHydrated).toHaveBeenCalledWith(true);
    });
  });
});
