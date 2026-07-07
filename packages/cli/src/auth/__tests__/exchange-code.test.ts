import { describe, expect, it } from 'vitest';
import { createExchangeCode, TokenExchangeError } from '@pagespace/cli';

const PARAMS = {
  tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
  clientId: 'pagespace-cli',
  code: 'ps_ac_test-code',
  redirectUri: 'http://127.0.0.1:51234/callback',
  codeVerifier: 'a'.repeat(43),
};

describe('createExchangeCode', () => {
  it('POSTs a form-encoded authorization_code grant with no client_secret', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          access_token: 'ps_at_x',
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'ps_rt_x',
          scope: 'account offline_access',
        }),
      };
    }) as unknown as typeof fetch;

    const tokens = await createExchangeCode(fetchImpl)(PARAMS);

    expect(capturedUrl).toBe(PARAMS.tokenEndpoint);
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe(PARAMS.code);
    expect(body.get('redirect_uri')).toBe(PARAMS.redirectUri);
    expect(body.get('client_id')).toBe(PARAMS.clientId);
    expect(body.get('code_verifier')).toBe(PARAMS.codeVerifier);
    expect(body.has('client_secret')).toBe(false);

    expect(tokens).toEqual({
      kind: 'oauth',
      accessToken: 'ps_at_x',
      refreshToken: 'ps_rt_x',
      expiresIn: 900,
      scope: 'account offline_access',
    });
  });

  it('parses an mcp-kind response (pure drive:* grant) into a static token result, with no refresh_token/expires_in expected', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        access_token: 'mcp_abc123',
        token_type: 'mcp',
        scope: 'drive:d1:member offline_access',
      }),
    })) as unknown as typeof fetch;

    const tokens = await createExchangeCode(fetchImpl)(PARAMS);

    expect(tokens).toEqual({ kind: 'mcp', token: 'mcp_abc123', scope: 'drive:d1:member offline_access' });
  });

  it('parses an mcp_update-kind response (update_key grant) into a secretless result naming the re-scoped token', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        token_type: 'mcp_update',
        token_id: 'tok123',
        scope: 'update_key:tok123 drive:d1:member',
      }),
    })) as unknown as typeof fetch;

    const tokens = await createExchangeCode(fetchImpl)(PARAMS);

    expect(tokens).toEqual({ kind: 'mcp_update', tokenId: 'tok123', scope: 'update_key:tok123 drive:d1:member' });
  });

  it('fails closed on an mcp_update response missing token_id', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ token_type: 'mcp_update', scope: 'update_key:tok123 drive:d1:member' }),
    })) as unknown as typeof fetch;

    await expect(createExchangeCode(fetchImpl)(PARAMS)).rejects.toThrow(TokenExchangeError);
  });

  it('throws a TokenExchangeError named after the server error code on a 400', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })) as unknown as typeof fetch;

    const error = await createExchangeCode(fetchImpl)(PARAMS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenExchangeError);
    expect((error as InstanceType<typeof TokenExchangeError>).code).toBe('invalid_grant');
  });

  it('fails closed on a malformed 2xx response body', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ access_token: 'only-this' }) })) as unknown as typeof fetch;

    await expect(createExchangeCode(fetchImpl)(PARAMS)).rejects.toThrow(TokenExchangeError);
  });

  it('fails closed when the network request throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(createExchangeCode(fetchImpl)(PARAMS)).rejects.toThrow(TokenExchangeError);
  });
});
