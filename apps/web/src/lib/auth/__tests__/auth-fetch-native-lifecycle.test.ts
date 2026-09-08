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
    supportsCSRF: () => false,
    dispatchAuthEvent: vi.fn(),
  }),
}));

const addListener = vi.fn();
vi.mock('@capacitor/app', () => ({ App: { addListener } }));

const dispatchEvent = vi.fn();

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
    async function foregroundAfter(minutes: number, refreshResult: { success: boolean; shouldLogout: boolean }) {
      isNativeApp.mockReturnValue(true);
      const { AuthFetch } = await import('../auth-fetch');
      const instance = new AuthFetch() as unknown as {
        refreshAuthSession: () => Promise<{ success: boolean; shouldLogout: boolean }>;
        clearSessionCache: () => void;
      };
      instance.refreshAuthSession = vi.fn().mockResolvedValue(refreshResult);

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
      return instance;
    }

    it('given a long background and a refresh that reports shouldLogout, should NOT dispatch auth:expired', async () => {
      const instance = await foregroundAfter(10, { success: false, shouldLogout: true });

      // Positive control: the branch under test really ran. Without this the
      // assertion below passes just as well when the handler never fired.
      expect(instance.refreshAuthSession).toHaveBeenCalledTimes(1);

      const expired = dispatchEvent.mock.calls.filter(
        ([e]) => (e as CustomEvent).type === 'auth:expired'
      );
      expect(expired).toHaveLength(0);
    });

    it('given a short background, should not refresh at all', async () => {
      const instance = await foregroundAfter(1, { success: false, shouldLogout: true });

      expect(instance.refreshAuthSession).not.toHaveBeenCalled();
      expect(dispatchEvent).not.toHaveBeenCalled();
    });
  });
});
