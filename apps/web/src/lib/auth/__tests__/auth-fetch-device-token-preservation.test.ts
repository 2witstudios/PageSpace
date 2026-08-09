import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/analytics/device-fingerprint', () => ({
  getOrCreateDeviceId: () => 'mock-device-id-12345',
}));

// Desktop platform storage so the singleton constructs cleanly.
vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    platform: 'desktop',
    getSessionToken: vi.fn().mockResolvedValue(null),
    getStoredSession: vi.fn().mockResolvedValue(null),
    storeSession: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
    getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'test-agent' }),
    usesBearer: vi.fn().mockReturnValue(true),
    supportsCSRF: vi.fn().mockReturnValue(false),
    dispatchAuthEvent: vi.fn(),
  }),
  resetPlatformStorage: vi.fn(),
}));

type RefreshInternals = {
  refreshDesktopSession: () => Promise<{ success: boolean; shouldLogout: boolean }>;
  refreshWebSession: () => Promise<{ success: boolean; shouldLogout: boolean }>;
};

describe('device token preservation on refresh (grace-clobber client fix)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let originalWindow: typeof global.window;
  let originalLocalStorage: typeof global.localStorage;
  let storeSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalWindow = global.window;
    originalLocalStorage = global.localStorage;

    mockFetch = vi.fn();
    global.fetch = mockFetch;

    storeSession = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(global, 'window', {
      value: {
        dispatchEvent: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        electron: {
          on: vi.fn(() => () => {}),
          auth: {
            getSession: vi.fn().mockResolvedValue({
              sessionToken: 'old-session',
              deviceToken: 'old-device-token',
            }),
            getDeviceInfo: vi.fn().mockResolvedValue({
              deviceId: 'device-1',
              userAgent: 'test-agent',
              appVersion: '1.0.0',
            }),
            storeSession,
          },
        },
      },
      writable: true,
    });

    const globalObj = globalThis as typeof globalThis & { [key: symbol]: unknown };
    delete globalObj[Symbol.for('pagespace.authfetch.singleton')];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    Object.defineProperty(global, 'window', { value: originalWindow, writable: true });
    Object.defineProperty(global, 'localStorage', { value: originalLocalStorage, writable: true });
  });

  it('desktop: KEEPS the existing device token when the refresh response omits deviceToken', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ sessionToken: 'new-session', csrfToken: 'csrf' }), {
        status: 200,
      }),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshDesktopSession();

    expect(result).toEqual({ success: true, shouldLogout: false });
    expect(storeSession).toHaveBeenCalledTimes(1);
    expect(storeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionToken: 'new-session',
        deviceToken: 'old-device-token', // preserved, NOT undefined
      }),
    );
  });

  it('desktop: persists the NEW device token when the response includes one', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ sessionToken: 'new-session', csrfToken: 'csrf', deviceToken: 'new-device-token' }),
        { status: 200 },
      ),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    await authFetch.refreshDesktopSession();

    expect(storeSession).toHaveBeenCalledWith(
      expect.objectContaining({ deviceToken: 'new-device-token' }),
    );
  });

  it('web: does NOT overwrite the stored device token when the response omits deviceToken', async () => {
    const setItem = vi.fn();
    Object.defineProperty(global, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => (key === 'deviceToken' ? 'old-device-token' : null)),
        setItem,
        removeItem: vi.fn(),
      },
      writable: true,
    });

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ csrfToken: 'csrf' }), { status: 200 }),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshWebSession();

    expect(result.success).toBe(true);
    expect(setItem).not.toHaveBeenCalledWith('deviceToken', expect.anything());
  });

  it('web: persists the new device token when the response includes one', async () => {
    const setItem = vi.fn();
    Object.defineProperty(global, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => (key === 'deviceToken' ? 'old-device-token' : null)),
        setItem,
        removeItem: vi.fn(),
      },
      writable: true,
    });

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ csrfToken: 'csrf', deviceToken: 'new-device-token' }), { status: 200 }),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    await authFetch.refreshWebSession();

    expect(setItem).toHaveBeenCalledWith('deviceToken', 'new-device-token');
  });
});
