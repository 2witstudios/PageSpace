import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/analytics/device-fingerprint', () => ({
  getOrCreateDeviceId: () => 'mock-device-id-12345',
}));
vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    platform: 'desktop',
    getSessionToken: vi.fn().mockResolvedValue(null),
    getStoredSession: vi.fn().mockResolvedValue(null),
    storeSession: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
    getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua' }),
    usesBearer: vi.fn().mockReturnValue(true),
    supportsCSRF: vi.fn().mockReturnValue(false),
    dispatchAuthEvent: vi.fn(),
  }),
  resetPlatformStorage: vi.fn(),
}));

type RefreshInternals = {
  refreshDesktopSession: () => Promise<{ success: boolean; shouldLogout: boolean }>;
};

describe('desktop device-refresh 401 single retry before logout', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let originalWindow: typeof global.window;
  let storeSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalWindow = global.window;
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
            getSession: vi.fn().mockResolvedValue({ sessionToken: 'old', deviceToken: 'old-device-token' }),
            getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua', appVersion: '1.0.0' }),
            storeSession,
          },
        },
      },
      writable: true,
    });

    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[
      Symbol.for('pagespace.authfetch.singleton')
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    Object.defineProperty(global, 'window', { value: originalWindow, writable: true });
  });

  it('two consecutive 401s: retries exactly once, then logs out', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope', reason: 'invalid_device_token' }), { status: 401 }),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshDesktopSession();

    expect(result).toEqual({ success: false, shouldLogout: true });
    // One original attempt + exactly one retry = 2 calls (no infinite loop).
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('401 then success: the retry recovers and does NOT log out', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'nope', reason: 'invalid_device_token' }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sessionToken: 'new-session', csrfToken: 'csrf', deviceToken: 'new-device-token' }),
          { status: 200 },
        ),
      );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshDesktopSession();

    expect(result).toEqual({ success: true, shouldLogout: false });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(storeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: 'new-session', deviceToken: 'new-device-token' }),
    );
  });

  it('immediate success: no retry, single request', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ sessionToken: 'new-session', csrfToken: 'csrf', deviceToken: 'new-device-token' }), {
        status: 200,
      }),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshDesktopSession();

    expect(result).toEqual({ success: true, shouldLogout: false });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
