/**
 * auth-store Tests
 * Tests for authentication state management, session handling, and helpers
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAuthStore, authStoreHelpers } from '../useAuthStore';

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

// Mock auth-fetch module
vi.mock('@/lib/auth/auth-fetch', () => ({
  clearCSRFToken: vi.fn(),
  refreshAuthSession: vi.fn().mockResolvedValue({ success: false }),
  clearJWTCache: vi.fn(),
}));

// Helper to create mock user
const createMockUser = (overrides = {}) => ({
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  image: null,
  emailVerified: null,
  role: 'user' as const,
  ...overrides,
});

describe('useAuthStore', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset the store before each test
    useAuthStore.setState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
      lastAuthCheck: null,
      hasHydrated: false,
      isRefreshing: false,
      refreshTimeoutId: null,
      csrfToken: null,
      sessionStartTime: null,
      lastActivity: null,
      lastActivityUpdate: null,
      failedAuthAttempts: 0,
      lastFailedAuthCheck: null,
      _authPromise: null,
      _serverSessionInitialized: false,
    });
    mockLocalStorage.clear();
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  describe('initial state', () => {
    it('given store is created, should have null user', () => {
      const { user } = useAuthStore.getState();
      expect(user).toBeNull();
    });

    it('given store is created, should not be loading', () => {
      const { isLoading } = useAuthStore.getState();
      expect(isLoading).toBe(false);
    });

    it('given store is created, should not be authenticated', () => {
      const { isAuthenticated } = useAuthStore.getState();
      expect(isAuthenticated).toBe(false);
    });

    it('given store is created, should not be hydrated', () => {
      const { hasHydrated } = useAuthStore.getState();
      expect(hasHydrated).toBe(false);
    });

    it('given store is created, should have zero failed attempts', () => {
      const { failedAuthAttempts } = useAuthStore.getState();
      expect(failedAuthAttempts).toBe(0);
    });
  });

  describe('setUser', () => {
    it('given a user object, should set the user and mark as authenticated', () => {
      const user = createMockUser();
      const { setUser } = useAuthStore.getState();

      setUser(user);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
    });

    it('given null user, should clear authentication', () => {
      useAuthStore.setState({ user: createMockUser(), isAuthenticated: true });
      const { setUser } = useAuthStore.getState();

      setUser(null);

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it('given a user when no session exists, should start a new session', () => {
      const user = createMockUser();
      const { setUser } = useAuthStore.getState();

      setUser(user);

      const state = useAuthStore.getState();
      expect(state.sessionStartTime).not.toBeNull();
      expect(state.lastActivity).not.toBeNull();
    });

    it('given a user, should clear failed auth attempts', () => {
      useAuthStore.setState({ failedAuthAttempts: 3, lastFailedAuthCheck: Date.now() });
      const { setUser } = useAuthStore.getState();

      setUser(createMockUser());

      const state = useAuthStore.getState();
      expect(state.failedAuthAttempts).toBe(0);
      expect(state.lastFailedAuthCheck).toBeNull();
    });

    it('given setUser called, should update lastAuthCheck', () => {
      const before = Date.now();
      const { setUser } = useAuthStore.getState();

      setUser(createMockUser());

      const { lastAuthCheck } = useAuthStore.getState();
      expect(lastAuthCheck).toBeGreaterThanOrEqual(before);
    });
  });

  describe('setLoading', () => {
    it('given true, should set loading state', () => {
      const { setLoading } = useAuthStore.getState();

      setLoading(true);

      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    it('given false, should clear loading state', () => {
      useAuthStore.setState({ isLoading: true });
      const { setLoading } = useAuthStore.getState();

      setLoading(false);

      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  describe('setRefreshing', () => {
    it('given true, should set refreshing state', () => {
      const { setRefreshing } = useAuthStore.getState();

      setRefreshing(true);

      expect(useAuthStore.getState().isRefreshing).toBe(true);
    });
  });

  describe('setCsrfToken', () => {
    it('given a token, should store it', () => {
      const { setCsrfToken } = useAuthStore.getState();

      setCsrfToken('csrf-token-123');

      expect(useAuthStore.getState().csrfToken).toBe('csrf-token-123');
    });
  });

  describe('setHydrated', () => {
    it('given true, should mark as hydrated', () => {
      const { setHydrated } = useAuthStore.getState();

      setHydrated(true);

      expect(useAuthStore.getState().hasHydrated).toBe(true);
    });
  });

  describe('updateActivity', () => {
    it('given user is authenticated, should update lastActivity', () => {
      useAuthStore.setState({
        isAuthenticated: true,
        lastActivity: Date.now() - 10000,
        lastActivityUpdate: Date.now() - 10000,
      });
      const before = Date.now();
      const { updateActivity } = useAuthStore.getState();

      updateActivity();

      const { lastActivity } = useAuthStore.getState();
      expect(lastActivity).toBeGreaterThanOrEqual(before);
    });

    it('given user is not authenticated, should not update lastActivity', () => {
      const oldActivity = Date.now() - 10000;
      useAuthStore.setState({ isAuthenticated: false, lastActivity: oldActivity });
      const { updateActivity } = useAuthStore.getState();

      updateActivity();

      expect(useAuthStore.getState().lastActivity).toBe(oldActivity);
    });

    it('given recent activity update, should throttle updates', () => {
      const recentUpdate = Date.now();
      useAuthStore.setState({
        isAuthenticated: true,
        lastActivity: recentUpdate,
        lastActivityUpdate: recentUpdate,
      });
      const { updateActivity } = useAuthStore.getState();

      updateActivity();

      // Should not update if within throttle window
      expect(useAuthStore.getState().lastActivityUpdate).toBe(recentUpdate);
    });
  });

  describe('startSession', () => {
    it('given startSession called, should set session times', () => {
      const before = Date.now();
      const { startSession } = useAuthStore.getState();

      startSession();

      const state = useAuthStore.getState();
      expect(state.sessionStartTime).toBeGreaterThanOrEqual(before);
      expect(state.lastActivity).toBeGreaterThanOrEqual(before);
    });
  });

  describe('endSession', () => {
    it('given endSession called, should clear user and session data', () => {
      useAuthStore.setState({
        user: createMockUser(),
        isAuthenticated: true,
        sessionStartTime: Date.now(),
        lastActivity: Date.now(),
        csrfToken: 'token',
      });
      const { endSession } = useAuthStore.getState();

      endSession();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.sessionStartTime).toBeNull();
      expect(state.lastActivity).toBeNull();
      expect(state.csrfToken).toBeNull();
    });

    it('given pending refresh timeout, should clear timeout and reset state', () => {
      const timeoutId = setTimeout(() => {}, 10000);
      useAuthStore.setState({ refreshTimeoutId: timeoutId });
      const { endSession } = useAuthStore.getState();

      endSession();

      // Observable: timeout ID is cleared from state
      expect(useAuthStore.getState().refreshTimeoutId).toBeNull();
      // Clean up the real timeout to prevent test pollution
      clearTimeout(timeoutId);
    });
  });

  describe('recordFailedAuth', () => {
    it('given recordFailedAuth called, should increment failed attempts', () => {
      useAuthStore.setState({ failedAuthAttempts: 2 });
      const { recordFailedAuth } = useAuthStore.getState();

      recordFailedAuth();

      expect(useAuthStore.getState().failedAuthAttempts).toBe(3);
    });

    it('given recordFailedAuth called, should set lastFailedAuthCheck', () => {
      const before = Date.now();
      const { recordFailedAuth } = useAuthStore.getState();

      recordFailedAuth();

      expect(useAuthStore.getState().lastFailedAuthCheck).toBeGreaterThanOrEqual(before);
    });
  });

  describe('clearFailedAttempts', () => {
    it('given failed attempts exist, should clear them', () => {
      useAuthStore.setState({ failedAuthAttempts: 5, lastFailedAuthCheck: Date.now() });
      const { clearFailedAttempts } = useAuthStore.getState();

      clearFailedAttempts();

      const state = useAuthStore.getState();
      expect(state.failedAuthAttempts).toBe(0);
      expect(state.lastFailedAuthCheck).toBeNull();
    });
  });

  describe('reset', () => {
    it('given reset called, should clear all state', () => {
      useAuthStore.setState({
        user: createMockUser(),
        isLoading: true,
        isAuthenticated: true,
        lastAuthCheck: Date.now(),
        sessionStartTime: Date.now(),
        lastActivity: Date.now(),
        failedAuthAttempts: 3,
        _serverSessionInitialized: true,
      });
      const { reset } = useAuthStore.getState();

      reset();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.isAuthenticated).toBe(false);
      expect(state.lastAuthCheck).toBeNull();
      expect(state.sessionStartTime).toBeNull();
      expect(state.failedAuthAttempts).toBe(0);
      expect(state._serverSessionInitialized).toBe(false);
    });
  });

  describe('initializeFromServer', () => {
    it('given a user, should initialize with authenticated state', () => {
      const user = createMockUser();
      const { initializeFromServer } = useAuthStore.getState();

      initializeFromServer(user);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state._serverSessionInitialized).toBe(true);
      expect(state.sessionStartTime).not.toBeNull();
    });

    it('given null user, should initialize without authentication', () => {
      const { initializeFromServer } = useAuthStore.getState();

      initializeFromServer(null);

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state._serverSessionInitialized).toBe(true);
      expect(state.sessionStartTime).toBeNull();
    });
  });

  describe('loadSession', () => {
    it('given successful auth check, should update user state', async () => {
      const user = createMockUser();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(user),
      } as Response);

      await useAuthStore.getState().loadSession();

      const state = useAuthStore.getState();
      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    it('given 401 response, should clear user state', async () => {
      useAuthStore.setState({ user: createMockUser(), isAuthenticated: true });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      await useAuthStore.getState().loadSession();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it('given force=false and already loading, should not trigger redundant fetch', async () => {
      // Simulate an in-progress auth load
      const pendingPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      useAuthStore.setState({ _authPromise: pendingPromise });
      vi.mocked(global.fetch).mockClear();

      // Call loadSession without force
      useAuthStore.getState().loadSession(false);

      // Observable: no new fetch triggered when already loading
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('given force=true, should bypass existing promise', async () => {
      const user = createMockUser();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(user),
      } as Response);
      useAuthStore.setState({ _authPromise: Promise.resolve() });

      await useAuthStore.getState().loadSession(true);

      expect(global.fetch).toHaveBeenCalled();
    });

    it('given network error, should record failed attempt', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await useAuthStore.getState().loadSession();

      expect(useAuthStore.getState().failedAuthAttempts).toBe(1);
      consoleError.mockRestore();
    });
  });
});

describe('authStoreHelpers', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
      lastAuthCheck: null,
      hasHydrated: false,
      isRefreshing: false,
      refreshTimeoutId: null,
      csrfToken: null,
      sessionStartTime: null,
      lastActivity: null,
      lastActivityUpdate: null,
      failedAuthAttempts: 0,
      lastFailedAuthCheck: null,
      _authPromise: null,
      _serverSessionInitialized: false,
    });
  });

  describe('isSessionExpired', () => {
    it('given no lastActivity, should return false', () => {
      useAuthStore.setState({ lastActivity: null, isAuthenticated: true });

      expect(authStoreHelpers.isSessionExpired()).toBe(false);
    });

    it('given not authenticated, should return false', () => {
      useAuthStore.setState({ lastActivity: Date.now(), isAuthenticated: false });

      expect(authStoreHelpers.isSessionExpired()).toBe(false);
    });

    it('given recent activity, should return false', () => {
      useAuthStore.setState({
        lastActivity: Date.now() - 1000, // 1 second ago
        isAuthenticated: true,
      });

      expect(authStoreHelpers.isSessionExpired()).toBe(false);
    });

    it('given old activity beyond timeout, should return true', () => {
      useAuthStore.setState({
        lastActivity: Date.now() - 61 * 60 * 1000, // 61 minutes ago (timeout is 60 min)
        isAuthenticated: true,
      });

      expect(authStoreHelpers.isSessionExpired()).toBe(true);
    });
  });

  describe('needsAuthCheck', () => {
    it('given no lastAuthCheck, should return true', () => {
      useAuthStore.setState({ lastAuthCheck: null });

      expect(authStoreHelpers.needsAuthCheck()).toBe(true);
    });

    it('given recent auth check, should return false', () => {
      useAuthStore.setState({ lastAuthCheck: Date.now() - 1000 }); // 1 second ago

      expect(authStoreHelpers.needsAuthCheck()).toBe(false);
    });

    it('given stale auth check beyond interval, should return true', () => {
      useAuthStore.setState({ lastAuthCheck: Date.now() - 16 * 60 * 1000 }); // 16 minutes ago

      expect(authStoreHelpers.needsAuthCheck()).toBe(true);
    });
  });

  describe('getSessionDuration', () => {
    it('given no session started, should return 0', () => {
      useAuthStore.setState({ sessionStartTime: null });

      expect(authStoreHelpers.getSessionDuration()).toBe(0);
    });

    it('given session started, should return duration in ms', () => {
      const startTime = Date.now() - 5000;
      useAuthStore.setState({ sessionStartTime: startTime });

      const duration = authStoreHelpers.getSessionDuration();
      expect(duration).toBeGreaterThanOrEqual(5000);
      expect(duration).toBeLessThan(6000);
    });
  });

  describe('shouldSkipAuthCheck', () => {
    it('given no failed attempts, should return false', () => {
      useAuthStore.setState({ failedAuthAttempts: 0, lastFailedAuthCheck: null });

      expect(authStoreHelpers.shouldSkipAuthCheck()).toBe(false);
    });

    it('given few failed attempts below threshold, should return false', () => {
      useAuthStore.setState({ failedAuthAttempts: 2, lastFailedAuthCheck: Date.now() });

      expect(authStoreHelpers.shouldSkipAuthCheck()).toBe(false);
    });

    it('given max failed attempts within timeout, should return true', () => {
      useAuthStore.setState({
        failedAuthAttempts: 5, // MAX_FAILED_AUTH_ATTEMPTS (web threshold)
        lastFailedAuthCheck: Date.now() - 1000, // 1 second ago (within 60s timeout)
      });

      expect(authStoreHelpers.shouldSkipAuthCheck()).toBe(true);
    });

    it('given max failed attempts but timeout passed, should return false', () => {
      useAuthStore.setState({
        failedAuthAttempts: 5,
        lastFailedAuthCheck: Date.now() - 61000, // 61 seconds ago (past 60s timeout)
      });

      expect(authStoreHelpers.shouldSkipAuthCheck()).toBe(false);
    });
  });

  describe('shouldLoadSession', () => {
    it('given not hydrated, should return true', () => {
      useAuthStore.setState({ hasHydrated: false });

      expect(authStoreHelpers.shouldLoadSession()).toBe(true);
    });

    it('given circuit breaker active, should return false', () => {
      useAuthStore.setState({
        hasHydrated: true,
        failedAuthAttempts: 5, // MAX_FAILED_AUTH_ATTEMPTS (web threshold)
        lastFailedAuthCheck: Date.now(),
      });

      expect(authStoreHelpers.shouldLoadSession()).toBe(false);
    });

    it('given already loading, should return false', () => {
      useAuthStore.setState({
        hasHydrated: true,
        _authPromise: Promise.resolve(),
      });

      expect(authStoreHelpers.shouldLoadSession()).toBe(false);
    });

    it('given server initialized and stale check, should return true', () => {
      useAuthStore.setState({
        hasHydrated: true,
        _serverSessionInitialized: true,
        lastAuthCheck: Date.now() - 16 * 60 * 1000, // Stale
      });

      expect(authStoreHelpers.shouldLoadSession()).toBe(true);
    });
  });

  describe('trackActivity', () => {
    it('should call updateActivity on the store', () => {
      useAuthStore.setState({
        isAuthenticated: true,
        lastActivityUpdate: Date.now() - 10000,
      });
      const before = Date.now();

      authStoreHelpers.trackActivity();

      expect(useAuthStore.getState().lastActivity).toBeGreaterThanOrEqual(before);
    });
  });
});
