import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression coverage for the Codex P1 finding on PR #2291: `refreshBearerSession()` used to
// await `storage.getStoredSession()` with no timeout — the identical iOS Keychain bridge call
// `getSessionTokenWithTimeout` already guards elsewhere in this file. A hung read here stranded
// the signin-recovery flow (`checkMeAuthenticated` -> 401 -> refresh -> refreshBearerSession)
// forever, via a different call site than the one useSigninRecovery.ts's hasDeviceToken() fix
// covers. See getStoredSessionWithTimeout in auth-fetch.ts.

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const getStoredSession = vi.fn();
const getDeviceInfo = vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua', appVersion: '1.0.0' });
vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    platform: 'ios',
    getSessionToken: vi.fn().mockResolvedValue(null),
    getStoredSession,
    storeSession: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
    getDeviceInfo,
    usesBearer: vi.fn().mockReturnValue(true),
    supportsCSRF: vi.fn().mockReturnValue(false),
    dispatchAuthEvent: vi.fn(),
  }),
  resetPlatformStorage: vi.fn(),
}));

type RefreshInternals = {
  refreshBearerSession: () => Promise<{ success: boolean; shouldLogout: boolean }>;
};

describe('refreshBearerSession: getStoredSession timeout', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    getStoredSession.mockReset();
    getDeviceInfo.mockClear();

    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[
      Symbol.for('pagespace.authfetch.singleton')
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('never hangs if getStoredSession never resolves, and does NOT force a logout', async () => {
    vi.useFakeTimers();
    try {
      getStoredSession.mockReturnValue(new Promise(() => {})); // never resolves

      const { AuthFetch } = await import('../auth-fetch');
      const authFetch = new AuthFetch() as unknown as RefreshInternals;

      const resultPromise = authFetch.refreshBearerSession();

      await vi.advanceTimersByTimeAsync(3000);

      const result = await resultPromise;

      // Transient timeout is retryable, not proof the device token is invalid — must not
      // force a logout of what may still be a perfectly valid session.
      expect(result).toEqual({ success: false, shouldLogout: false });
      // The hung read must short-circuit the refresh — no network call was ever attempted.
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a genuinely missing device token (resolved null) still forces a logout, unlike a timeout', async () => {
    getStoredSession.mockResolvedValue(null);

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshBearerSession();

    expect(result).toEqual({ success: false, shouldLogout: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
