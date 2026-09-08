import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAuthStore } from '../useAuthStore';

/**
 * The cold-launch gate in `loadSession` used to read
 * `isCapacitorApp() && getPlatform() === 'ios'` and attach a Keychain bearer
 * token only on iOS. It now asks the resolved `PlatformStorage` whether the
 * platform authenticates by bearer, which is where that knowledge already lives.
 *
 * The subtle half is what happens when a bearer platform has *no* bearer token.
 * The old iOS branch declared the user signed out. On Android that is wrong for
 * every session that exists today: the in-WebView web flow leaves a **cookie**
 * session, and `AndroidStorage.getSessionToken()` returns null for exactly that
 * case. So a missing bearer token now falls through to `/api/auth/me`, which
 * settles it with the cookies the WebView already holds.
 */

const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(global, 'localStorage', { value: mockLocalStorage });

const warmSessionCache = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  clearCSRFToken: vi.fn(),
  refreshAuthSession: vi.fn().mockResolvedValue({ success: false, shouldLogout: true }),
  clearSessionCache: vi.fn(),
  warmSessionCache: (token: string) => warmSessionCache(token),
}));

const getSessionToken = vi.fn<() => Promise<string | null>>();
vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    platform: 'android',
    getSessionToken,
    getStoredSession: vi.fn().mockResolvedValue(null),
    storeSession: vi.fn(),
    clearSession: vi.fn(),
    getDeviceId: vi.fn().mockResolvedValue('device-1'),
    getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua' }),
    usesBearer: () => true,
    supportsCSRF: () => false,
    dispatchAuthEvent: vi.fn(),
  }),
}));

const mockUser = { id: 'user-1', name: 'A', email: 'a@example.com', image: null, emailVerified: null };

function resetStore() {
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
}

describe('loadSession on a bearer platform', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetStore();
    mockLocalStorage.clear();
    vi.clearAllMocks();
    getSessionToken.mockReset();
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockUser), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('given a stored bearer token, should attach it and pre-warm the fetch cache', async () => {
    getSessionToken.mockResolvedValue('ps_sess_native');

    await useAuthStore.getState().loadSession(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/me');
    expect((init as RequestInit & { headers: Record<string, string> }).headers['Authorization'])
      .toBe('Bearer ps_sess_native');
    expect(warmSessionCache).toHaveBeenCalledWith('ps_sess_native');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('given no bearer token, should still ask the server rather than declaring the user signed out', async () => {
    getSessionToken.mockResolvedValue(null);

    await useAuthStore.getState().loadSession(true);

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.anything());
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit & { headers: Record<string, string> }).headers['Authorization'])
      .toBeUndefined();
    // The cookie session the in-WebView web flow left behind is a real session.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe('user-1');
  });

  it('given the secure store faults, should not treat it as proof the user is signed out', async () => {
    getSessionToken.mockRejectedValue(new Error('[Android] Secure storage read failed'));

    await useAuthStore.getState().loadSession(true);

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.anything());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('given no bearer token and no cookie session either, should end up unauthenticated', async () => {
    getSessionToken.mockResolvedValue(null);
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    await useAuthStore.getState().loadSession(true);

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });
});
