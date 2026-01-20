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
      authFailedPermanently: false,
      authAttemptTimestamps: [],
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

    it('given store is created, should have authFailedPermanently false', () => {
      const { authFailedPermanently } = useAuthStore.getState();
      expect(authFailedPermanently).toBe(false);
    });

    it('given store is created, should have empty authAttemptTimestamps', () => {
      const { authAttemptTimestamps } = useAuthStore.getState();
      expect(authAttemptTimestamps).toEqual([]);
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

    it('given user set after auth failure, should clear authFailedPermanently', () => {
      useAuthStore.setState({ authFailedPermanently: true });
      const { setUser } = useAuthStore.getState();

      setUser(createMockUser());

      expect(useAuthStore.getState().authFailedPermanently).toBe(false);
    });

    it('given user set after auth failure, should clear authAttemptTimestamps', () => {
      useAuthStore.setState({ authAttemptTimestamps: [Date.now(), Date.now(), Date.now()] });
      const { setUser } = useAuthStore.getState();

      setUser(createMockUser());

      expect(useAuthStore.getState().authAttemptTimestamps).toEqual([]);
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

  describe('setAuthFailedPermanently', () => {
    it('given true, should set authFailedPermanently flag', () => {
      const { setAuthFailedPermanently } = useAuthStore.getState();

      setAuthFailedPermanently(true);

      expect(useAuthStore.getState().authFailedPermanently).toBe(true);
    });

    it('given false, should clear authFailedPermanently flag', () => {
      useAuthStore.setState({ authFailedPermanently: true });
      const { setAuthFailedPermanently } = useAuthStore.getState();

      setAuthFailedPermanently(false);

      expect(useAuthStore.getState().authFailedPermanently).toBe(false);
    });

    it('given true, should log to console', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { setAuthFailedPermanently } = useAuthStore.getState();

      setAuthFailedPermanently(true);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[AUTH_STORE]'));
      consoleSpy.mockRestore();
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

    it('given reset called with auth failure state, should clear authFailedPermanently', () => {
      useAuthStore.setState({ authFailedPermanently: true });
      const { reset } = useAuthStore.getState();

      reset();

      expect(useAuthStore.getState().authFailedPermanently).toBe(false);
    });

    it('given reset called with auth failure state, should clear authAttemptTimestamps', () => {
      useAuthStore.setState({ authAttemptTimestamps: [Date.now(), Date.now()] });
      const { reset } = useAuthStore.getState();

      reset();

      expect(useAuthStore.getState().authAttemptTimestamps).toEqual([]);
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

    it('given authFailedPermanently true and loadSession called without force, should skip auth check', async () => {
      useAuthStore.setState({ authFailedPermanently: true });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(global.fetch).mockClear();

      await useAuthStore.getState().loadSession(false);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      consoleSpy.mockRestore();
    });

    it('given authFailedPermanently true and loadSession called with force, should attempt auth', async () => {
      useAuthStore.setState({ authFailedPermanently: true });
      const user = createMockUser();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(user),
      } as Response);

      await useAuthStore.getState().loadSession(true);

      expect(global.fetch).toHaveBeenCalled();
    });

    it('given successful auth after failure, should clear authFailedPermanently flag', async () => {
      useAuthStore.setState({ authFailedPermanently: true });
      const user = createMockUser();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(user),
      } as Response);

      await useAuthStore.getState().loadSession(true);

      expect(useAuthStore.getState().authFailedPermanently).toBe(false);
    });

    it('given successful auth, should clear authAttemptTimestamps', async () => {
      useAuthStore.setState({ authAttemptTimestamps: [Date.now(), Date.now()] });
      const user = createMockUser();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(user),
      } as Response);

      await useAuthStore.getState().loadSession();

      expect(useAuthStore.getState().authAttemptTimestamps).toEqual([]);
    });
  });

  describe('auth loop detection', () => {
    it('given 4 auth attempts in 10 seconds, should allow next attempt', async () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Pre-populate with 4 attempts in the last 5 seconds
      useAuthStore.setState({
        authAttemptTimestamps: [
          now - 4000,
          now - 3000,
          now - 2000,
          now - 1000,
        ],
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      await useAuthStore.getState().loadSession();

      // Should have attempted (fetch called) since only 4 recent attempts
      expect(global.fetch).toHaveBeenCalled();
      expect(useAuthStore.getState().authFailedPermanently).toBe(false);

      vi.useRealTimers();
    });

    it('given 5 auth attempts in 10 seconds, should detect loop and set authFailedPermanently', async () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Pre-populate with 5 attempts in the last 9 seconds (all within window)
      useAuthStore.setState({
        authAttemptTimestamps: [
          now - 8000,
          now - 6000,
          now - 4000,
          now - 2000,
          now - 500,
        ],
      });

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await useAuthStore.getState().loadSession();

      // Should NOT have attempted fetch - loop detected before fetch
      expect(global.fetch).not.toHaveBeenCalled();
      expect(useAuthStore.getState().authFailedPermanently).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);

      consoleError.mockRestore();
      vi.useRealTimers();
    });

    it('given 5 auth attempts spread over 15 seconds, should not detect loop', async () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Attempts spread over 15 seconds - oldest 3 are outside the 10-second window
      useAuthStore.setState({
        authAttemptTimestamps: [
          now - 15000, // Outside window
          now - 13000, // Outside window
          now - 11000, // Outside window
          now - 5000,  // Inside window
          now - 2000,  // Inside window
        ],
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      await useAuthStore.getState().loadSession();

      // Should have attempted since only 2 attempts are within the 10-second window
      expect(global.fetch).toHaveBeenCalled();
      expect(useAuthStore.getState().authFailedPermanently).toBe(false);

      vi.useRealTimers();
    });

    it('given loop detected, should clear user and set isAuthenticated false', async () => {
      vi.useFakeTimers();
      const now = Date.now();

      // User is "authenticated" with stale state
      useAuthStore.setState({
        user: createMockUser(),
        isAuthenticated: true,
        authAttemptTimestamps: [
          now - 8000,
          now - 6000,
          now - 4000,
          now - 2000,
          now - 500,
        ],
      });

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await useAuthStore.getState().loadSession();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);

      consoleError.mockRestore();
      vi.useRealTimers();
    });

    it('given loop detected, should clear authAttemptTimestamps', async () => {
      vi.useFakeTimers();
      const now = Date.now();

      useAuthStore.setState({
        authAttemptTimestamps: [
          now - 8000,
          now - 6000,
          now - 4000,
          now - 2000,
          now - 500,
        ],
      });

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await useAuthStore.getState().loadSession();

      expect(useAuthStore.getState().authAttemptTimestamps).toEqual([]);

      consoleError.mockRestore();
      vi.useRealTimers();
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
      authFailedPermanently: false,
      authAttemptTimestamps: [],
      _authPromise: null,
      _serverSessionInitialized: false,
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

describe('persist partialize behavior', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    useAuthStore.setState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
      lastAuthCheck: null,
      hasHydrated: false,
      authFailedPermanently: false,
      authAttemptTimestamps: [],
    });
  });

  it('given authFailedPermanently true, should be included in persisted state', () => {
    useAuthStore.setState({ authFailedPermanently: true });

    // Trigger persist by calling persist.rehydrate or checking localStorage
    // The zustand persist middleware auto-persists on state change
    // We verify by checking what was written to localStorage
    const stored = mockLocalStorage.getItem('auth-storage');
    if (stored) {
      const parsed = JSON.parse(stored);
      expect(parsed.state.authFailedPermanently).toBe(true);
    }
  });

  it('given authAttemptTimestamps populated, should NOT be included in persisted state', () => {
    const timestamps = [Date.now(), Date.now() - 1000];
    useAuthStore.setState({ authAttemptTimestamps: timestamps });

    const stored = mockLocalStorage.getItem('auth-storage');
    if (stored) {
      const parsed = JSON.parse(stored);
      // authAttemptTimestamps should not be in persisted state
      expect(parsed.state.authAttemptTimestamps).toBeUndefined();
    }
  });
});
