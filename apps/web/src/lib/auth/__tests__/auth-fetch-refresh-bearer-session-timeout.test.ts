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

// Round 2: the getStoredSession read above is timeout-guarded, but the refresh POST itself
// (the actual network call this whole chain exists to make) had no timeout at all — a true
// network stall here left the AuthFetch singleton's isRefreshing/refreshPromise permanently
// set, wedging auth for the whole app session, not just this page load.
describe('refreshBearerSession: refresh fetch timeout', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    getStoredSession.mockReset();
    getStoredSession.mockResolvedValue({ deviceToken: 'dt_valid' });
    // vi.restoreAllMocks() in the sibling describe's afterEach wipes this mock's
    // mockResolvedValue (set only once, at module scope) along with everything else — reapply
    // it here so this describe doesn't depend on run order relative to the other one.
    getDeviceInfo.mockReset();
    getDeviceInfo.mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua', appVersion: '1.0.0' });

    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[
      Symbol.for('pagespace.authfetch.singleton')
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('never hangs if the refresh fetch never resolves, and does NOT force a logout', async () => {
    vi.useFakeTimers();
    try {
      // Mirrors real fetch()'s AbortController contract: the request promise only settles
      // once the passed signal actually fires.
      mockFetch.mockImplementation(
        (_url: string, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      const { AuthFetch } = await import('../auth-fetch');
      const authFetch = new AuthFetch() as unknown as RefreshInternals;

      const resultPromise = authFetch.refreshBearerSession();

      await vi.advanceTimersByTimeAsync(8000);

      const result = await resultPromise;

      // Transient network stall is retryable, not proof the device token is dead — must not
      // force a logout of what may still be a perfectly valid session.
      expect(result).toEqual({ success: false, shouldLogout: false });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never hangs if the response body stalls after ok headers arrive (P1: timeout must stay armed through response.json())', async () => {
    // fetch() resolves as soon as headers arrive, before the body is fully read — a server
    // that flushes headers then stalls mid-body would otherwise hang here with no timeout
    // protection if the abort controller were cleared right after the fetch() await, since
    // response.json() runs afterward, outside that guard.
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation((_url: string, options?: { signal?: AbortSignal }) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }),
        }),
      );

      const { AuthFetch } = await import('../auth-fetch');
      const authFetch = new AuthFetch() as unknown as RefreshInternals;

      const resultPromise = authFetch.refreshBearerSession();

      await vi.advanceTimersByTimeAsync(8000);

      const result = await resultPromise;

      expect(result).toEqual({ success: false, shouldLogout: false });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('control: a fast successful refresh is unaffected by the new timeout', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sessionToken: 'st_new', csrfToken: 'csrf_new', deviceToken: 'dt_new' }),
    });

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshBearerSession();

    expect(result).toEqual({ success: true, shouldLogout: false });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
