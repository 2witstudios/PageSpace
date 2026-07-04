import { describe, expect, it } from 'vitest';
import { isNetworkError, isRateLimitError, isServerError, isValidationError } from '@pagespace/sdk';
import { createRefreshAccessToken } from '../oauth-refresh.js';

const METADATA = {
  authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
  tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
};

function fakeDiscover(hostsSeen: string[] = []) {
  return async (host: string) => {
    hostsSeen.push(host);
    return METADATA;
  };
}

describe('createRefreshAccessToken', () => {
  it('POSTs a form-encoded refresh_token grant to the discovered token endpoint', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedContentType: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      capturedContentType = (init?.headers as Record<string, string>)['Content-Type'];
      return new Response(
        JSON.stringify({ access_token: 'ps_at_new', expires_in: 900, refresh_token: 'ps_rt_new', scope: 'account offline_access' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const refresh = createRefreshAccessToken({
      host: 'https://pagespace.ai',
      clientId: 'pagespace-cli',
      discoverMetadata: fakeDiscover(),
      fetch: fetchImpl,
      now: () => Date.parse('2026-07-03T00:00:00.000Z'),
    });

    const tokens = await refresh('ps_rt_old');

    expect(capturedUrl).toBe(METADATA.tokenEndpoint);
    expect(capturedContentType).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(capturedBody);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('ps_rt_old');
    expect(form.get('client_id')).toBe('pagespace-cli');

    expect(tokens.accessToken).toBe('ps_at_new');
    expect(tokens.refreshToken).toBe('ps_rt_new');
    expect(tokens.accessExpiresAt).toBe(Date.parse('2026-07-03T00:00:00.000Z') + 900 * 1000);
    expect(tokens.refreshExpiresAt).toBeGreaterThan(tokens.accessExpiresAt);
  });

  it('never leaks the old or new refresh token in a thrown error message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;

    const refresh = createRefreshAccessToken({
      host: 'https://pagespace.ai',
      clientId: 'pagespace-cli',
      discoverMetadata: fakeDiscover(),
      fetch: fetchImpl,
    });

    await expect(refresh('ps_rt_super_secret')).rejects.toSatisfy((error: unknown) => {
      expect(error instanceof Error && error.message).not.toContain('ps_rt_super_secret');
      return true;
    });
  });

  it('classifies a 400 invalid_grant as a validation error (terminal — re-login required)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const refresh = createRefreshAccessToken({ host: 'https://pagespace.ai', clientId: 'c', discoverMetadata: fakeDiscover(), fetch: fetchImpl });

    let caught: unknown;
    try {
      await refresh('r');
    } catch (error) {
      caught = error;
    }
    expect(isValidationError(caught)).toBe(true);
  });

  it('classifies a 429 as a rate-limit error (retryable)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch;
    const refresh = createRefreshAccessToken({ host: 'https://pagespace.ai', clientId: 'c', discoverMetadata: fakeDiscover(), fetch: fetchImpl });

    let caught: unknown;
    try {
      await refresh('r');
    } catch (error) {
      caught = error;
    }
    expect(isRateLimitError(caught)).toBe(true);
  });

  it('classifies a 500 as a server error (retryable)', async () => {
    const fetchImpl = (async () => new Response('oops', { status: 500 })) as typeof fetch;
    const refresh = createRefreshAccessToken({ host: 'https://pagespace.ai', clientId: 'c', discoverMetadata: fakeDiscover(), fetch: fetchImpl });

    let caught: unknown;
    try {
      await refresh('r');
    } catch (error) {
      caught = error;
    }
    expect(isServerError(caught)).toBe(true);
  });

  it('classifies a network failure as a network error (retryable)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const refresh = createRefreshAccessToken({ host: 'https://pagespace.ai', clientId: 'c', discoverMetadata: fakeDiscover(), fetch: fetchImpl });

    let caught: unknown;
    try {
      await refresh('r');
    } catch (error) {
      caught = error;
    }
    expect(isNetworkError(caught)).toBe(true);
  });

  it('discovers the token endpoint for the configured host', async () => {
    const hostsSeen: string[] = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: 'a', expires_in: 900, refresh_token: 'r', scope: 'account' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch;
    const refresh = createRefreshAccessToken({
      host: 'https://self-hosted.example',
      clientId: 'c',
      discoverMetadata: fakeDiscover(hostsSeen),
      fetch: fetchImpl,
    });
    await refresh('r');
    expect(hostsSeen).toEqual(['https://self-hosted.example']);
  });
});
