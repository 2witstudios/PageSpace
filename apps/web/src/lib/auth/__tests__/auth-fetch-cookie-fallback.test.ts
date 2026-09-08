import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression coverage for the Android CSRF breakage opened by PR #2557.
 *
 * `AndroidStorage` reports `usesBearer() === true`,
 * but until native sign-in exists an Android session is a **cookie** session with
 * no bearer token. `fetchWithAuth` used to pick its credentials from that stated
 * preference, so those requests went out with neither `Authorization` nor
 * `X-CSRF-Token` — and the server enforces CSRF exactly when a session request
 * carries no bearer (`lib/auth/index.ts`, `requireCSRF && isSessionAuth &&
 * !hasBearerAuth`). Every POST/PATCH/PUT/DELETE answered 403 CSRF_TOKEN_MISSING.
 * The same branch also dropped `X-Device-Token`.
 *
 * `buildAuthCredentials` now mirrors the server's rule: bearer if one can be had,
 * cookie credentials otherwise.
 */

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/capacitor-bridge', () => ({
  isNativeApp: () => false,
}));

const storageMock = {
  platform: 'android' as string,
  getSessionToken: vi.fn<() => Promise<string | null>>(),
  getStoredSession: vi.fn(),
  storeSession: vi.fn().mockResolvedValue(undefined),
  clearSession: vi.fn().mockResolvedValue(undefined),
  getDeviceId: vi.fn().mockResolvedValue('device-1'),
  getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua' }),
  usesBearer: vi.fn().mockReturnValue(true),
  dispatchAuthEvent: vi.fn(),
};

vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => storageMock,
}));

type SentRequest = { url: string; headers: Record<string, string> };

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return { ...(init?.headers as Record<string, string> | undefined) };
}

describe('fetchWithAuth: credentials follow what the request can actually present', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let sent: SentRequest[];

  beforeEach(() => {
    vi.resetModules();
    sent = [];
    originalFetch = global.fetch;

    storageMock.platform = 'android';
    storageMock.usesBearer.mockReturnValue(true);
    storageMock.getSessionToken.mockReset();
    storageMock.getSessionToken.mockResolvedValue(null);
    storageMock.getStoredSession.mockReset();
    storageMock.getStoredSession.mockResolvedValue({
      sessionToken: '',
      csrfToken: null,
      deviceId: 'device-1',
      deviceToken: 'ps_dev_legacy',
    });

    mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, headers: headersOf(init) });
      if (url === '/api/auth/csrf') {
        return new Response(JSON.stringify({ csrfToken: 'csrf-from-server' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;

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

  it('given a bearer platform with no bearer token, should send the CSRF token a cookie session needs', async () => {
    const { fetchWithAuth } = await import('../auth-fetch');

    await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

    const mutation = sent.find((r) => r.url === '/api/pages');
    expect(mutation?.headers['X-CSRF-Token']).toBe('csrf-from-server');
    expect(mutation?.headers['Authorization']).toBeUndefined();
  });

  it('given a bearer platform with no bearer token, should still send the device token', async () => {
    const { fetchWithAuth } = await import('../auth-fetch');

    await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

    const mutation = sent.find((r) => r.url === '/api/pages');
    expect(mutation?.headers['X-Device-Token']).toBe('ps_dev_legacy');
  });

  it('given a bearer token IS available, should authenticate with it and send no CSRF token', async () => {
    storageMock.getSessionToken.mockResolvedValue('ps_sess_native');
    const { fetchWithAuth } = await import('../auth-fetch');

    await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

    const mutation = sent.find((r) => r.url === '/api/pages');
    expect(mutation?.headers['Authorization']).toBe('Bearer ps_sess_native');
    expect(mutation?.headers['X-CSRF-Token']).toBeUndefined();
    // A bearer request is CSRF-exempt server-side, so it must not pay for a token.
    expect(sent.some((r) => r.url === '/api/auth/csrf')).toBe(false);
  });

  it('given a GET from a bearer platform with no bearer token, should not fetch a CSRF token', async () => {
    const { fetchWithAuth } = await import('../auth-fetch');

    await fetchWithAuth('/api/pages');

    // The GET really went out; without this the negative below is vacuous.
    expect(sent.filter((r) => r.url === '/api/pages')).toHaveLength(1);
    expect(sent.some((r) => r.url === '/api/auth/csrf')).toBe(false);
  });

  it('given the secure store faults while reading the device token, should still send the request with CSRF', async () => {
    // `AndroidStorage.getStoredSession` rejects on a broken keystore. That must
    // degrade the device *marker*, not turn an authenticable request into a throw.
    storageMock.getStoredSession.mockRejectedValue(new Error('[Android] Secure storage read failed'));
    const { fetchWithAuth } = await import('../auth-fetch');

    const response = await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    const mutation = sent.find((r) => r.url === '/api/pages');
    expect(mutation?.headers['X-CSRF-Token']).toBe('csrf-from-server');
    expect(mutation?.headers['X-Device-Token']).toBeUndefined();
  });

  // The cookie path's store read is on the request hot path and crosses the same
  // native bridge the bearer read just timed out on. Unbounded, a hung Keychain
  // would leave every fetchWithAuth promise pending forever — no 401, so no
  // recovery. Reachable only since this change: the line used to be WebStorage's
  // synchronous localStorage read.
  it('given the store hangs, should still send the request rather than hang forever', async () => {
    vi.useFakeTimers();
    try {
      storageMock.getStoredSession.mockReturnValue(new Promise(() => {}));
      const { fetchWithAuth } = await import('../auth-fetch');

      const pending = fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });
      await vi.advanceTimersByTimeAsync(3500);
      const response = await pending;

      expect(response.status).toBe(200);
      const mutation = sent.find((r) => r.url === '/api/pages');
      expect(mutation?.headers['X-Device-Token']).toBeUndefined();
      expect(mutation?.headers['X-CSRF-Token']).toBe('csrf-from-server');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the desktop Electron path is unchanged', () => {
    beforeEach(() => {
      storageMock.platform = 'desktop';
    });

    it('given a desktop session token, should send only the bearer token', async () => {
      storageMock.getSessionToken.mockResolvedValue('ps_sess_desktop');
      Object.defineProperty(global, 'window', {
        value: {
          dispatchEvent: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          electron: {
            isDesktop: true,
            on: vi.fn(),
            auth: { getSessionToken: vi.fn().mockResolvedValue('ps_sess_desktop') },
          },
        },
        writable: true,
      });

      const { fetchWithAuth } = await import('../auth-fetch');
      await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

      const mutation = sent.find((r) => r.url === '/api/pages');
      expect(mutation?.headers['Authorization']).toBe('Bearer ps_sess_desktop');
      expect(mutation?.headers['X-CSRF-Token']).toBeUndefined();
      expect(mutation?.headers['X-Device-Token']).toBeUndefined();
    });
  });

  describe('web is unchanged', () => {
    beforeEach(() => {
      storageMock.platform = 'web';
      storageMock.usesBearer.mockReturnValue(false);
    });

    it('given a web mutation, should send the CSRF and device tokens as before', async () => {
      const { fetchWithAuth } = await import('../auth-fetch');
      await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

      const mutation = sent.find((r) => r.url === '/api/pages');
      expect(mutation?.headers['X-CSRF-Token']).toBe('csrf-from-server');
      expect(mutation?.headers['X-Device-Token']).toBe('ps_dev_legacy');
      expect(mutation?.headers['Authorization']).toBeUndefined();
    });

    it('given a caller-supplied header, should preserve it alongside the credentials', async () => {
      const { fetchWithAuth } = await import('../auth-fetch');
      await fetchWithAuth('/api/pages', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      });

      const mutation = sent.find((r) => r.url === '/api/pages');
      expect(mutation?.headers['Content-Type']).toBe('application/json');
      expect(mutation?.headers['X-CSRF-Token']).toBe('csrf-from-server');
    });
  });
});
