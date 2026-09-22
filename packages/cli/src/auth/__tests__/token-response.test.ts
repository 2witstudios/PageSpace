import { describe, expect, it } from 'vitest';
import { createExchangeCode, parseTokenResponse, TokenExchangeError } from '@pagespace/cli';

const BEARER = { token_type: 'Bearer', access_token: 'ps_at_x', expires_in: 900, refresh_token: 'ps_rt_x', scope: 'manage_keys offline_access' };

describe('parseTokenResponse (CLI adapter over the SDK wire contract)', () => {
  it('reads a Bearer pair into the oauth credential the CLI persists', () => {
    expect(parseTokenResponse(BEARER)).toEqual({
      kind: 'oauth',
      accessToken: 'ps_at_x',
      refreshToken: 'ps_rt_x',
      expiresIn: 900,
      scope: 'manage_keys offline_access',
    });
  });

  it('refuses a Bearer answer with no refresh token — the CLI always asks for offline_access and cannot persist an access-only grant', () => {
    const { refresh_token: _omitted, ...accessOnly } = BEARER;
    expect(parseTokenResponse(accessOnly)).toBeNull();
  });

  it('fails the code exchange closed on an access-only answer', async () => {
    const { refresh_token: _omitted, ...accessOnly } = BEARER;
    const fetchImpl = (async () => new Response(JSON.stringify(accessOnly), { status: 200 })) as typeof fetch;

    const error = await createExchangeCode(fetchImpl)({
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
      clientId: 'pagespace-cli',
      code: 'c',
      redirectUri: 'http://127.0.0.1:1/callback',
      codeVerifier: 'v'.repeat(43),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TokenExchangeError);
    expect((error as InstanceType<typeof TokenExchangeError>).code).toBe('invalid_response');
  });
});
