import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * "The desktop Electron path shares these call sites and its behaviour must not
 * change" is the standing constraint on this phase, and the post-401 retry is the
 * part of it this change actually restructured: the two near-identical credential
 * blocks in `fetch()` became one `buildAuthCredentials`, whose refresh stage
 * routes desktop through `getSessionFromElectron()` rather than
 * `storage.getSessionToken()`.
 *
 * Nothing covered that. `auth-fetch-desktop-401-retry.test.ts` exercises
 * `refreshDesktopSession`'s own retry logic, and the cookie-fallback suite covers
 * only the *initial* desktop request. So a refactor that silently sent the stale
 * token — or fell through to cookie credentials — on the retry would have passed
 * the whole suite.
 */

vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/capacitor-bridge', () => ({ isNativeApp: () => false }));

const storageGetSessionToken = vi.fn().mockResolvedValue(null);
const storageGetStoredSession = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    platform: 'desktop',
    getSessionToken: storageGetSessionToken,
    getStoredSession: storageGetStoredSession,
    storeSession: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
    getDeviceId: vi.fn().mockResolvedValue('device-1'),
    getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua' }),
    usesBearer: vi.fn().mockReturnValue(true),
    supportsCSRF: vi.fn().mockReturnValue(false),
    dispatchAuthEvent: vi.fn(),
  }),
}));

type Sent = { url: string; headers: Record<string, string> };

describe('desktop: the retry after a refresh carries the FRESH bearer token', () => {
  let originalFetch: typeof global.fetch;
  let originalWindow: typeof global.window;
  let sent: Sent[];
  let electronGetSessionToken: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    originalFetch = global.fetch;
    originalWindow = global.window;
    sent = [];
    storageGetSessionToken.mockClear();
    storageGetStoredSession.mockClear();

    // Electron hands back the OLD token until the device refresh lands, then the NEW one.
    electronGetSessionToken = vi.fn().mockResolvedValue('ps_sess_old');

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });

      if (url === '/api/auth/device/refresh') {
        // The refresh succeeded; from here Electron reports the rotated token.
        electronGetSessionToken.mockResolvedValue('ps_sess_new');
        return new Response(
          JSON.stringify({ sessionToken: 'ps_sess_new', csrfToken: 'c', deviceToken: 'ps_dev_new' }),
          { status: 200 }
        );
      }

      // The protected route 401s while the old token is presented, then succeeds.
      const auth = sent[sent.length - 1].headers['Authorization'];
      return auth === 'Bearer ps_sess_new'
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;

    Object.defineProperty(global, 'window', {
      value: {
        dispatchEvent: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        electron: {
          isDesktop: true,
          on: vi.fn(() => () => {}),
          auth: {
            getSessionToken: electronGetSessionToken,
            getSession: vi.fn().mockResolvedValue({
              sessionToken: 'ps_sess_old',
              deviceToken: 'ps_dev_old',
            }),
            getDeviceInfo: vi.fn().mockResolvedValue({
              deviceId: 'device-1',
              userAgent: 'ua',
              appVersion: '1.0.0',
            }),
            storeSession: vi.fn().mockResolvedValue(undefined),
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
    global.fetch = originalFetch;
    Object.defineProperty(global, 'window', { value: originalWindow, writable: true });
    vi.restoreAllMocks();
  });

  it('should retry with the rotated token, not the stale one', async () => {
    const { fetchWithAuth } = await import('../auth-fetch');

    const response = await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);

    const attempts = sent.filter((r) => r.url === '/api/pages');
    expect(attempts).toHaveLength(2);
    expect(attempts[0].headers['Authorization']).toBe('Bearer ps_sess_old');
    expect(attempts[1].headers['Authorization']).toBe('Bearer ps_sess_new');
  });

  it('should read the retry token through Electron IPC, not the storage adapter', async () => {
    // `readBearerToken`'s refresh stage keeps desktop on `getSessionFromElectron()`,
    // which carries the retry-once-after-a-null and the concurrent-IPC dedup that
    // `DesktopStorage.getSessionToken()` does not.
    const { fetchWithAuth } = await import('../auth-fetch');

    await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

    expect(electronGetSessionToken).toHaveBeenCalled();
    expect(storageGetSessionToken).not.toHaveBeenCalled();
  });

  it('should never attach cookie credentials while a bearer token is available', async () => {
    const { fetchWithAuth } = await import('../auth-fetch');

    await fetchWithAuth('/api/pages', { method: 'POST', body: '{}' });

    for (const attempt of sent.filter((r) => r.url === '/api/pages')) {
      expect(attempt.headers['X-CSRF-Token']).toBeUndefined();
      expect(attempt.headers['X-Device-Token']).toBeUndefined();
    }
    expect(sent.some((r) => r.url === '/api/auth/csrf')).toBe(false);
  });
});
