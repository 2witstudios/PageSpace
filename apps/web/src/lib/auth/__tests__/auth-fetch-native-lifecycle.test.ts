import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The lifecycle gate in `initializeListeners` read
 * `isCapacitorApp() && getPlatform() === 'ios'`, so an Android shell registered
 * no `appStateChange` listener at all: no session-cache clear on foreground, and
 * no proactive refresh after a long background — the two things that keep a
 * backgrounded native app from coming back to a dead session. `@capacitor/app`
 * fires that event on every Capacitor platform, so the gate is now "is this a
 * native shell?".
 */

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    platform: 'android',
    getSessionToken: vi.fn().mockResolvedValue(null),
    getStoredSession: vi.fn().mockResolvedValue(null),
    storeSession: vi.fn(),
    clearSession: vi.fn(),
    getDeviceId: vi.fn().mockResolvedValue('device-1'),
    getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua' }),
    usesBearer: () => true,
    dispatchAuthEvent: vi.fn(),
  }),
}));

const addListener = vi.fn();
vi.mock('@capacitor/app', () => ({ App: { addListener } }));

const dispatchEvent = vi.fn();

// The defect only bites a signed-IN user — `refreshAuthSession` guards its
// dispatch on `isAuthenticated`, and the whole point is that an Android
// magic-link user IS authenticated while having no device token. Without this
// mock the store reports false, the dispatch is suppressed for the wrong reason,
// and the test passes even when the fix is absent.
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ isAuthenticated: true }) },
}));

const isNativeApp = vi.fn();
vi.mock('@/lib/capacitor-bridge', () => ({
  isNativeApp: () => isNativeApp(),
}));

describe('AuthFetch native lifecycle registration', () => {
  beforeEach(() => {
    vi.resetModules();
    addListener.mockClear();
    isNativeApp.mockReset();
    dispatchEvent.mockClear();
    Object.defineProperty(global, 'window', {
      value: { dispatchEvent, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given any native shell, should register the appStateChange listener', async () => {
    isNativeApp.mockReturnValue(true);

    const { AuthFetch } = await import('../auth-fetch');
    new AuthFetch();
    // The registration happens inside an awaited dynamic import.
    await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function)));
  });

  it('given a browser, should register nothing', async () => {
    isNativeApp.mockReturnValue(false);

    const { AuthFetch } = await import('../auth-fetch');
    new AuthFetch();
    await Promise.resolve();

    expect(addListener).not.toHaveBeenCalled();
  });

  // Regression: arming this listener on Android turned a live cookie session into
  // a forced sign-out on every foreground-after-5-minutes.
  //
  // `refreshBearerSession` answers `shouldLogout: true` the moment there is no
  // device token to present, and on Android that is the ordinary state of a
  // magic-link session — the verify route mints a device token only for desktop,
  // the OAuth handoff cookie never reaches the WebView, and `useAuth`'s lazy
  // device registration returns early for Capacitor. This is the *proactive*
  // path: nothing has been refused, so a failed refresh is not evidence the
  // session is over. Only the next request can establish that, and its 401 runs
  // the reactive path, which dispatches behind its own `isAuthenticated` guard.
  describe('a failed proactive refresh does not sign the user out', () => {
    // Deliberately does NOT stub `refreshAuthSession`. An earlier version of this
    // test did, and so proved nothing: `refreshAuthSession` dispatches
    // `auth:expired` *itself*, so stubbing it hid the very code path under test
    // and a broken fix passed. The real method runs here — the storage mock
    // returns no device token, which is what drives `refreshBearerSession` to
    // `shouldLogout: true`, exactly as a magic-link Android session would.
    async function foregroundAfter(minutes: number) {
      isNativeApp.mockReturnValue(true);
      const { AuthFetch } = await import('../auth-fetch');
      const instance = new AuthFetch() as unknown as {
        refreshAuthSession: (o?: { allowSignOut?: boolean }) => Promise<{ success: boolean; shouldLogout: boolean }>;
      };
      const refreshSpy = vi.spyOn(instance, 'refreshAuthSession');

      await vi.waitFor(() => expect(addListener).toHaveBeenCalled());
      const handler = addListener.mock.calls[0][1] as (s: { isActive: boolean }) => Promise<void>;

      const realNow = Date.now;
      let now = realNow();
      Date.now = () => now;
      try {
        await handler({ isActive: false });
        now += minutes * 60 * 1000;
        await handler({ isActive: true });
      } finally {
        Date.now = realNow;
      }
      return refreshSpy;
    }

    it('given a long background and no device token, should NOT dispatch auth:expired', async () => {
      const refreshSpy = await foregroundAfter(10);

      // Positive controls: the branch really ran, the real refresh really
      // concluded shouldLogout, and it was asked not to act on it.
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledWith({ allowSignOut: false });
      await expect(refreshSpy.mock.results[0].value).resolves.toEqual({
        success: false,
        shouldLogout: true,
      });

      const expired = dispatchEvent.mock.calls.filter(
        ([e]) => (e as CustomEvent).type === 'auth:expired'
      );
      expect(expired).toHaveLength(0);
    });

    it('given a short background, should not refresh at all', async () => {
      const refreshSpy = await foregroundAfter(1);

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(dispatchEvent).not.toHaveBeenCalled();
    });
  });
});
