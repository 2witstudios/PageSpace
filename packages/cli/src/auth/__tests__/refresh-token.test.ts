import { describe, expect, it } from 'vitest';
import { createRefreshToken, RefreshTokenError } from '@pagespace/cli';

const PARAMS = {
  tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
  clientId: 'pagespace-cli',
  refreshToken: 'ps_rt_test-refresh-token',
};

describe('createRefreshToken', () => {
  it('POSTs a form-encoded refresh_token grant with no client_secret', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          access_token: 'ps_at_new',
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'ps_rt_new',
          scope: 'account offline_access',
        }),
      };
    }) as unknown as typeof fetch;

    const tokens = await createRefreshToken(fetchImpl)(PARAMS);

    expect(capturedUrl).toBe(PARAMS.tokenEndpoint);
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(PARAMS.refreshToken);
    expect(body.get('client_id')).toBe(PARAMS.clientId);
    expect(body.has('client_secret')).toBe(false);

    expect(tokens).toEqual({
      accessToken: 'ps_at_new',
      refreshToken: 'ps_rt_new',
      expiresIn: 900,
      scope: 'account offline_access',
    });
  });

  it('throws a RefreshTokenError named after the server error code on a 400', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })) as unknown as typeof fetch;

    const error = await createRefreshToken(fetchImpl)(PARAMS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefreshTokenError);
    expect((error as InstanceType<typeof RefreshTokenError>).code).toBe('invalid_grant');
  });

  it('throws a RefreshTokenError on a 401 (revoked/reused refresh token)', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_grant' }),
    })) as unknown as typeof fetch;

    await expect(createRefreshToken(fetchImpl)(PARAMS)).rejects.toThrow(RefreshTokenError);
  });

  it('fails closed on a malformed 2xx response body', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ access_token: 'only-this' }) })) as unknown as typeof fetch;

    await expect(createRefreshToken(fetchImpl)(PARAMS)).rejects.toThrow(RefreshTokenError);
  });

  it('fails closed when the network request throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(createRefreshToken(fetchImpl)(PARAMS)).rejects.toThrow(RefreshTokenError);
  });

  it('never includes the refresh token in a thrown error', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })) as unknown as typeof fetch;

    const error = await createRefreshToken(fetchImpl)(PARAMS).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(PARAMS.refreshToken);
  });
});
