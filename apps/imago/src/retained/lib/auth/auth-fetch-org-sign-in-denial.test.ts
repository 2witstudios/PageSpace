import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * D-OW-45: every request goes through fetchWithAuth (SWR fetchers and mutations alike), so an org sign-in denial
 * there reaches the re-authentication prompt, and the caller still gets the response unchanged.
 */

vi.mock('@/retained/lib/logging/client-logger', () => ({
  createClientLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/retained/lib/capacitor-bridge', () => ({ isNativeApp: () => false }));

const storageMock = {
  platform: 'web' as string,
  getSessionToken: vi.fn().mockResolvedValue(null),
  getStoredSession: vi.fn().mockResolvedValue(null),
  storeSession: vi.fn().mockResolvedValue(undefined),
  clearSession: vi.fn().mockResolvedValue(undefined),
  getDeviceId: vi.fn().mockResolvedValue('device-1'),
  getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'device-1', userAgent: 'ua' }),
  usesBearer: vi.fn().mockReturnValue(false),
  dispatchAuthEvent: vi.fn(),
};
vi.mock('@/retained/lib/auth/platform-storage', () => ({ getPlatformStorage: () => storageMock }));

const reporting = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('@/retained/stores/useOrgReauthStore', () => ({ useOrgReauthStore: { getState: () => reporting } }));

describe('fetchWithAuth reports org sign-in denials (D-OW-45)', () => {
  let originalFetch: typeof global.fetch;
  let answer: () => Response;

  beforeEach(() => {
    vi.resetModules();
    reporting.report.mockClear();
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string) =>
      url === '/api/auth/csrf' ? new Response(JSON.stringify({ csrfToken: 'c' }), { status: 200 }) : answer(),
    ) as unknown as typeof global.fetch;
    Object.defineProperty(global, 'window', {
      value: { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { origin: 'http://localhost' } },
      writable: true,
    });
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for('pagespace.authfetch.singleton')];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('SEC-2 (partial) a 403 carrying a sign-in code opens the prompt, naming the org, and the caller still reads the response', async () => {
    answer = () => new Response(JSON.stringify({ error: 'x', code: 'org_strong_sign_in_required', orgId: 'org_nw' }), { status: 403 });
    const { fetchWithAuth } = await import('./auth-fetch');

    const response = await fetchWithAuth('/api/pages/p1');

    expect(reporting.report).toHaveBeenCalledWith({ code: 'org_strong_sign_in_required', orgId: 'org_nw' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'org_strong_sign_in_required' });
  });

  it('an ordinary 403 opens nothing', async () => {
    answer = () => new Response(JSON.stringify({ error: 'nope', code: 'insufficient_role' }), { status: 403 });
    const { fetchWithAuth } = await import('./auth-fetch');

    await fetchWithAuth('/api/pages/p1');

    expect(reporting.report).not.toHaveBeenCalled();
  });
});
