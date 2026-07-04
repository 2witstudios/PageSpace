import { describe, expect, it } from 'vitest';
import { isNetworkError, isRateLimitError, isServerError, isTimeoutError } from '@pagespace/sdk';
import { createRefreshAccessToken } from '../silent-refresh.js';

const TOKEN_ENDPOINT = 'https://pagespace.ai/api/oauth/token';
const CLIENT_ID = 'pagespace-cli';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('createRefreshAccessToken', () => {
  it('posts a well-formed refresh_token grant and resolves the rotated token pair', async () => {
    let capturedBody: string | undefined;
    let capturedContentType: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body);
      capturedContentType = new Headers(init?.headers).get('content-type');
      return jsonResponse(200, {
        access_token: 'ps_at_new',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'ps_rt_new',
        scope: 'account offline_access',
      });
    }) as typeof fetch;

    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl, () => 1_000_000);
    const tokens = await refresh('ps_rt_old');

    expect(tokens.accessToken).toBe('ps_at_new');
    expect(tokens.refreshToken).toBe('ps_rt_new');
    expect(tokens.accessExpiresAt).toBe(1_000_000 + 900 * 1000);
    expect(tokens.refreshExpiresAt).toBeGreaterThan(1_000_000);

    expect(capturedContentType).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('ps_rt_old');
    expect(params.get('client_id')).toBe(CLIENT_ID);
  });

  it('surfaces the server-granted scope on the resolved tokens (so a caller like whoami can report the current, authoritative grant)', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        access_token: 'ps_at_new',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'ps_rt_new',
        scope: 'account',
      })) as typeof fetch;

    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl);
    const tokens = await refresh('ps_rt_old');

    expect(tokens.scope).toBe('account');
  });

  it('never leaks the refresh token in a thrown error on failure', async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: 'invalid_grant' })) as typeof fetch;
    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl);

    await expect(refresh('ps_rt_super_secret_value')).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes('ps_rt_super_secret_value');
    });
  });

  it('classifies a 400 invalid_grant as a definitive (non-retryable) rejection', async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: 'invalid_grant' })) as typeof fetch;
    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl);

    let thrown: unknown;
    try {
      await refresh('ps_rt_old');
    } catch (error) {
      thrown = error;
    }
    expect(isNetworkError(thrown)).toBe(false);
    expect(isTimeoutError(thrown)).toBe(false);
    expect(isRateLimitError(thrown)).toBe(false);
    expect(isServerError(thrown)).toBe(false);
  });

  it('classifies a 429 as retryable (rate limited)', async () => {
    const fetchImpl = (async () => jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '5' })) as typeof fetch;
    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl);

    await expect(refresh('ps_rt_old')).rejects.toSatisfy((error: unknown) => isRateLimitError(error));
  });

  it('classifies a 500 as retryable (server error)', async () => {
    const fetchImpl = (async () => jsonResponse(500, { error: 'internal' })) as typeof fetch;
    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl);

    await expect(refresh('ps_rt_old')).rejects.toSatisfy((error: unknown) => isServerError(error));
  });

  it('classifies a network failure as retryable (network error)', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch;
    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl);

    await expect(refresh('ps_rt_old')).rejects.toSatisfy((error: unknown) => isNetworkError(error));
  });

  it('fails closed (non-retryable) on a malformed 2xx response body', async () => {
    const fetchImpl = (async () => jsonResponse(200, { unexpected: true })) as typeof fetch;
    const refresh = createRefreshAccessToken(TOKEN_ENDPOINT, CLIENT_ID, fetchImpl);

    let thrown: unknown;
    try {
      await refresh('ps_rt_old');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(isNetworkError(thrown)).toBe(false);
    expect(isTimeoutError(thrown)).toBe(false);
    expect(isRateLimitError(thrown)).toBe(false);
    expect(isServerError(thrown)).toBe(false);
  });
});
