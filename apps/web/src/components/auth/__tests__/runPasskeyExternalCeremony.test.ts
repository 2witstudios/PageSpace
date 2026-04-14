import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

import { startAuthentication } from '@simplewebauthn/browser';
import { runPasskeyExternalCeremony } from '../runPasskeyExternalCeremony';

const authResponse = { id: 'cred-1', rawId: 'raw', type: 'public-key' };

function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: unknown, _init?: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler();
    }
    throw new Error(`Unmocked fetch: ${url}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('runPasskeyExternalCeremony', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(startAuthentication).mockResolvedValue(
      authResponse as unknown as Awaited<ReturnType<typeof startAuthentication>>,
    );
  });

  it('runs login-csrf → options → startAuthentication → verify → returns exchange deep link', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/login-csrf': () => jsonResponse({ csrfToken: 'csrf-abc' }),
      '/api/auth/passkey/authenticate/options': () =>
        jsonResponse({ options: { challenge: 'chal-1', allowCredentials: [] } }),
      '/api/auth/passkey/authenticate': () =>
        jsonResponse({ success: true, desktopExchangeCode: 'exchange-xyz' }),
    });

    const result = await runPasskeyExternalCeremony({
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.deepLink).toContain('pagespace://auth-exchange');
    expect(result.deepLink).toContain('code=exchange-xyz');
    expect(result.deepLink).toContain('provider=passkey');
  });

  it('sends desktopExchange=true and device fields to the verify endpoint', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/login-csrf': () => jsonResponse({ csrfToken: 'csrf-abc' }),
      '/api/auth/passkey/authenticate/options': () =>
        jsonResponse({ options: { challenge: 'chal-1' } }),
      '/api/auth/passkey/authenticate': () =>
        jsonResponse({ success: true, desktopExchangeCode: 'code-1' }),
    });

    await runPasskeyExternalCeremony({
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const verifyCall = fetchImpl.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0] === '/api/auth/passkey/authenticate',
    );
    expect(verifyCall).toBeDefined();
    const init = verifyCall![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      platform: 'desktop',
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
      desktopExchange: true,
      expectedChallenge: 'chal-1',
      csrfToken: 'csrf-abc',
    });
    expect(body.response).toEqual(authResponse);
  });

  it('returns an error result when the CSRF fetch fails', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/login-csrf': () =>
        jsonResponse({ error: 'server error' }, 500),
    });

    const result = await runPasskeyExternalCeremony({
      deviceId: 'd',
      deviceName: 'n',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/csrf/i);
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it('returns an error result when the options fetch fails', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/login-csrf': () => jsonResponse({ csrfToken: 'csrf-abc' }),
      '/api/auth/passkey/authenticate/options': () =>
        jsonResponse({ error: 'rate limited' }, 429),
    });

    const result = await runPasskeyExternalCeremony({
      deviceId: 'd',
      deviceName: 'n',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/rate limited/i);
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it('returns an error result when the verify response lacks desktopExchangeCode', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/login-csrf': () => jsonResponse({ csrfToken: 'csrf-abc' }),
      '/api/auth/passkey/authenticate/options': () =>
        jsonResponse({ options: { challenge: 'c' } }),
      '/api/auth/passkey/authenticate': () =>
        jsonResponse({ success: true }),
    });

    const result = await runPasskeyExternalCeremony({
      deviceId: 'd',
      deviceName: 'n',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/exchange/i);
  });

  it('returns an error result when startAuthentication is cancelled by the user', async () => {
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      Object.assign(new Error('The operation either timed out or was not allowed'), {
        name: 'NotAllowedError',
      }),
    );

    const fetchImpl = mockFetch({
      '/api/auth/login-csrf': () => jsonResponse({ csrfToken: 'csrf-abc' }),
      '/api/auth/passkey/authenticate/options': () =>
        jsonResponse({ options: { challenge: 'c' } }),
    });

    const result = await runPasskeyExternalCeremony({
      deviceId: 'd',
      deviceName: 'n',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/cancel/i);
  });
});
