import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => mockLogger,
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

function makeElectron(session: { sessionToken: string; deviceToken?: string | null } | null) {
  return {
    on: vi.fn(() => () => {}),
    auth: {
      getSession: vi.fn().mockResolvedValue(session),
      getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua', appVersion: '1.0.0' }),
      storeSession: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('correlated logout reason at shouldLogout branches', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let originalWindow: typeof global.window;
  let originalLocalStorage: typeof global.localStorage;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalWindow = global.window;
    originalLocalStorage = global.localStorage;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockLogger.warn.mockClear();

    Object.defineProperty(global, 'window', {
      value: {
        dispatchEvent: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        electron: makeElectron({ sessionToken: 'old', deviceToken: 'old-device-token' }),
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
    Object.defineProperty(global, 'localStorage', { value: originalLocalStorage, writable: true });
  });

  it('desktop 401: logs the server-provided reason on logout', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope', reason: 'device_id_mismatch' }), { status: 401 }),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshDesktopSession();

    expect(result.shouldLogout).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ logoutReason: 'device_id_mismatch' }),
    );
  });

  it('desktop no-device-token: logs a no_device_token reason on logout', async () => {
    Object.defineProperty(global, 'window', {
      value: {
        dispatchEvent: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        electron: makeElectron({ sessionToken: 'old', deviceToken: null }),
      },
      writable: true,
    });

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshDesktopSession();

    expect(result.shouldLogout).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ logoutReason: 'no_device_token' }),
    );
  });

  it('web 401: logs the server-provided reason on logout', async () => {
    Object.defineProperty(global, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => (key === 'deviceToken' ? 'old-device-token' : null)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
      writable: true,
    });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope', reason: 'rotation_failed' }), { status: 401 }),
    );

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshWebSession();

    expect(result.shouldLogout).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ logoutReason: 'rotation_failed' }),
    );
  });

  it('web no-device-token: logs a no_device_token reason on logout', async () => {
    Object.defineProperty(global, 'localStorage', {
      value: {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
      writable: true,
    });

    const { AuthFetch } = await import('../auth-fetch');
    const authFetch = new AuthFetch() as unknown as RefreshInternals;

    const result = await authFetch.refreshWebSession();

    expect(result.shouldLogout).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ logoutReason: 'no_device_token' }),
    );
  });
});
