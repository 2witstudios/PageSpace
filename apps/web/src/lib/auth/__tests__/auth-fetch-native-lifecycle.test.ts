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

const isNativeApp = vi.fn();
vi.mock('@/lib/capacitor-bridge', () => ({
  isNativeApp: () => isNativeApp(),
}));

describe('AuthFetch native lifecycle registration', () => {
  beforeEach(() => {
    vi.resetModules();
    addListener.mockClear();
    isNativeApp.mockReset();
    Object.defineProperty(global, 'window', {
      value: { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
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
});
