import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { exchangeAppleAuthorizationCode, revokeAppleRefreshToken } from '../apple-token-api';
import type { AppleSigningConfig } from '../apple-client-secret';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const config: AppleSigningConfig = {
  teamId: 'M96WTV3CKX',
  keyId: 'ABC123DEFG',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sentForm = (): { url: string; form: URLSearchParams; init: RequestInit } => {
  const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
  return { url, form: new URLSearchParams(String(init.body)), init };
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeAppleAuthorizationCode', () => {
  it('given a native code, should POST the authorization_code grant without a redirect_uri and return the refresh token', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1', id_token: 'idt' }),
    );

    const result = await exchangeAppleAuthorizationCode({ code: 'code-1', clientId: 'ai.pagespace.ios', config });

    expect(result).toEqual({ ok: true, refreshToken: 'rt-1', idToken: 'idt' });
    const { url, form, init } = sentForm();
    expect(url).toBe('https://appleid.apple.com/auth/token');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(form.get('client_id')).toBe('ai.pagespace.ios');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')?.split('.')).toHaveLength(3);
    expect(form.has('redirect_uri')).toBe(false);
  });

  it('given a web code with a redirect uri, should send that redirect_uri', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { refresh_token: 'rt', id_token: 'idt' }));

    await exchangeAppleAuthorizationCode({
      code: 'code-2',
      clientId: 'ai.pagespace.web',
      redirectUri: 'https://pagespace.ai/api/auth/apple/callback',
      config,
    });

    expect(sentForm().form.get('redirect_uri')).toBe('https://pagespace.ai/api/auth/apple/callback');
  });

  it('given Apple rejects the code, should return the error code without throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));

    const result = await exchangeAppleAuthorizationCode({ code: 'used', clientId: 'ai.pagespace.ios', config });

    expect(result).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('given a success response without a refresh token, should report it as a failure', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { access_token: 'at', id_token: 'idt' }));

    const result = await exchangeAppleAuthorizationCode({ code: 'c', clientId: 'ai.pagespace.ios', config });

    expect(result).toEqual({ ok: false, reason: 'missing_refresh_token' });
  });

  it('given the network call rejects (timeout), should return a failure without throwing', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const result = await exchangeAppleAuthorizationCode({ code: 'c', clientId: 'ai.pagespace.ios', config });

    expect(result).toEqual({ ok: false, reason: 'TimeoutError' });
  });
});

describe('revokeAppleRefreshToken', () => {
  it('given a refresh token, should POST it to /auth/revoke with the refresh_token hint for its client', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const result = await revokeAppleRefreshToken({ refreshToken: 'rt-1', clientId: 'ai.pagespace.web', config });

    expect(result).toEqual({ ok: true });
    const { url, form, init } = sentForm();
    expect(url).toBe('https://appleid.apple.com/auth/revoke');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(form.get('client_id')).toBe('ai.pagespace.web');
    expect(form.get('token')).toBe('rt-1');
    expect(form.get('token_type_hint')).toBe('refresh_token');
    expect(form.get('client_secret')?.split('.')).toHaveLength(3);
  });

  it('given Apple answers with an error, should return the error code without throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(400, { error: 'invalid_client' }));

    const result = await revokeAppleRefreshToken({ refreshToken: 'rt', clientId: 'ai.pagespace.ios', config });

    expect(result).toEqual({ ok: false, reason: 'invalid_client' });
  });

  it('given the network call rejects, should return a failure without throwing', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

    const result = await revokeAppleRefreshToken({ refreshToken: 'rt', clientId: 'ai.pagespace.ios', config });

    expect(result).toEqual({ ok: false, reason: 'TypeError' });
  });
});
