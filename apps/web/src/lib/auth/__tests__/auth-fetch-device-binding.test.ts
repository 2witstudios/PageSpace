import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `refreshBearerSession` used to read the session (for the device token) and
 * then ask `getDeviceInfo()` separately (for the device id), so the pair it sent
 * came from two different reads. `/api/auth/device/refresh` enforces strict
 * binding and answers a mismatched pair 401 as a stolen token, after which
 * `clearSession()` destroys both credentials — a forced sign-out produced by a
 * race, not by anything the user did.
 *
 * The id now comes from the same read as the token, at BOTH sites: the refresh
 * request body and the `storeSession` call on the success path. Fixing only the
 * body would send one id and persist another — the same divergence, one refresh
 * later.
 */

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/capacitor-bridge', () => ({
  isNativeApp: () => false,
}));

const getStoredSession = vi.fn();
const getDeviceInfo = vi.fn();
const storeSession = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    platform: 'android',
    getSessionToken: vi.fn().mockResolvedValue(null),
    getStoredSession,
    storeSession,
    clearSession: vi.fn().mockResolvedValue(undefined),
    getDeviceId: vi.fn().mockResolvedValue('id-from-device-info'),
    getDeviceInfo,
    usesBearer: vi.fn().mockReturnValue(true),
    supportsCSRF: vi.fn().mockReturnValue(false),
    dispatchAuthEvent: vi.fn(),
  }),
}));

type RefreshInternals = {
  refreshBearerSession: () => Promise<{ success: boolean; shouldLogout: boolean }>;
};

describe('refreshBearerSession: the device token and its id come from one read', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.resetModules();
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    storeSession.mockClear();

    // The two reads disagree — exactly the state the fix exists for.
    getStoredSession.mockResolvedValue({
      sessionToken: 'ps_sess_old',
      csrfToken: null,
      deviceId: 'id-the-token-is-bound-to',
      deviceToken: 'ps_dev_token',
    });
    getDeviceInfo.mockResolvedValue({ deviceId: 'id-from-device-info', userAgent: 'ua' });

    Object.defineProperty(global, 'window', {
      value: { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
      writable: true,
    });

    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[
      Symbol.for('pagespace.authfetch.singleton')
    ];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function refresh() {
    const { AuthFetch } = await import('../auth-fetch');
    const instance = new AuthFetch() as unknown as RefreshInternals;
    return instance.refreshBearerSession();
  }

  it('should send the deviceId from the session the token was read from', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ sessionToken: 'ps_sess_new', deviceToken: 'ps_dev_new' }), { status: 200 })
    );

    await refresh();

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.deviceToken).toBe('ps_dev_token');
    expect(body.deviceId).toBe('id-the-token-is-bound-to');
  });

  it('should persist the same deviceId it just sent', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ sessionToken: 'ps_sess_new', deviceToken: 'ps_dev_new' }), { status: 200 })
    );

    await refresh();

    const [, init] = mockFetch.mock.calls[0];
    const sentId = JSON.parse((init as RequestInit).body as string).deviceId;
    expect(storeSession).toHaveBeenCalledTimes(1);
    expect(storeSession.mock.calls[0][0].deviceId).toBe(sentId);
    expect(storeSession.mock.calls[0][0].deviceId).toBe('id-the-token-is-bound-to');
  });

  it('given a session that names no deviceId, should fall back to the device info', async () => {
    // A legacy web-flow session on Android carries an empty deviceId when no id
    // was ever recorded; the refresh must still be able to name one.
    getStoredSession.mockResolvedValue({
      sessionToken: '',
      csrfToken: null,
      deviceId: '',
      deviceToken: 'ps_dev_legacy',
    });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ csrfToken: 'c', deviceToken: 'ps_dev_new' }), { status: 200 })
    );

    await refresh();

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).deviceId).toBe('id-from-device-info');
    expect(storeSession.mock.calls[0][0].deviceId).toBe('id-from-device-info');
  });

  it('given neither read names a deviceId, should force re-authentication rather than send a blank binding', async () => {
    getStoredSession.mockResolvedValue({
      sessionToken: '',
      csrfToken: null,
      deviceId: '',
      deviceToken: 'ps_dev_legacy',
    });
    getDeviceInfo.mockResolvedValue({ deviceId: '', userAgent: 'ua' });

    const result = await refresh();

    expect(result).toEqual({ success: false, shouldLogout: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
