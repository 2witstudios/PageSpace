/**
 * Phase 3 leaf 1 — the client half of "Sign in with PageSpace": the pure
 * authorize-URL / callback functions (`sign-in.ts`) and the token-endpoint
 * calls with an injected `fetch` (`token-endpoint.ts`).
 */
import { describe, expect, it } from 'vitest';
import { classifyRefreshFailure } from '../decide.js';
import {
  isNetworkError,
  isRateLimitError,
  isResponseValidationError,
  isServerError,
  isTimeoutError,
  type RateLimitError,
} from '../../errors.js';
import {
  AUTHORIZATION_ERROR_CODES,
  buildAuthorizeUrl,
  PAGESPACE_CALLBACK_PATH,
  pageSpaceOAuthEndpoints,
  parseCallback,
} from '../sign-in.js';
import {
  createTokenEndpointRefresh,
  discoverMetadata,
  exchangeAuthorizationCode,
  parseTokenResponse,
  readOAuthErrorCode,
  refreshWithTokenEndpoint,
  revokeToken,
} from '../token-endpoint.js';

const BASE_URL = 'https://pagespace.ai';
const TOKEN_ENDPOINT = 'https://pagespace.ai/api/oauth/token';
const REVOCATION_ENDPOINT = 'https://pagespace.ai/api/oauth/revoke';

interface CapturedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly contentType: string | null;
  readonly body: URLSearchParams;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A fetch double that records each request and answers from `respond`. */
function recordingFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get('content-type'),
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    return respond();
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new TypeError(message);
  }) as typeof fetch;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

/** Every string an error could surface: message, name, and anything nested on it. */
function everythingVisible(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return [error.name, error.message, String(error.stack ?? ''), JSON.stringify(error), cause === undefined ? '' : everythingVisible(cause)].join('\n');
}

const BEARER_BODY = {
  access_token: 'ps_at_new',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'ps_rt_new',
  scope: 'profile offline_access',
};

describe('pageSpaceOAuthEndpoints', () => {
  it('derives the authorize, token and revoke endpoints from a base URL, tolerating trailing slashes', () => {
    expect(pageSpaceOAuthEndpoints('https://pagespace.ai//')).toEqual({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOCATION_ENDPOINT,
    });
  });
});

describe('PAGESPACE_CALLBACK_PATH', () => {
  it('is the standard callback path decided in [D-10]', () => {
    expect(PAGESPACE_CALLBACK_PATH).toBe('/auth/pagespace/callback');
  });
});

describe('buildAuthorizeUrl', () => {
  const params = {
    baseUrl: BASE_URL,
    clientId: 'app_123',
    redirectUri: 'https://app.example.com/auth/pagespace/callback',
    scope: 'profile drive:abc123:member offline_access',
    state: 'state-value_1',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  };

  it('produces the exact RFC 6749 §4.1.1 authorization request with S256 PKCE', () => {
    const url = new URL(buildAuthorizeUrl(params));

    expect(`${url.origin}${url.pathname}`).toBe('https://pagespace.ai/api/oauth/authorize');
    expect([...url.searchParams.entries()]).toEqual([
      ['response_type', 'code'],
      ['client_id', 'app_123'],
      ['redirect_uri', 'https://app.example.com/auth/pagespace/callback'],
      ['scope', 'profile drive:abc123:member offline_access'],
      ['state', 'state-value_1'],
      ['code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'],
      ['code_challenge_method', 'S256'],
    ]);
  });

  it('percent-encodes values so a hostile value cannot inject a second parameter', () => {
    const url = new URL(buildAuthorizeUrl({ ...params, state: 'a&client_id=evil', redirectUri: 'swipesend://callback?x=1' }));

    expect(url.searchParams.getAll('client_id')).toEqual(['app_123']);
    expect(url.searchParams.get('state')).toBe('a&client_id=evil');
    expect(url.searchParams.get('redirect_uri')).toBe('swipesend://callback?x=1');
  });

  it('is pure: the same input always yields the same URL', () => {
    expect(buildAuthorizeUrl(params)).toBe(buildAuthorizeUrl({ ...params }));
  });
});

describe('parseCallback', () => {
  const callback = (query: string) => `https://app.example.com/auth/pagespace/callback?${query}`;

  it('returns the code when the state matches', () => {
    expect(parseCallback(callback('code=ps_ac_abc&state=s1'), 's1')).toEqual({ ok: true, code: 'ps_ac_abc' });
  });

  it('accepts a URL object as well as a string', () => {
    expect(parseCallback(new URL(callback('code=c&state=s1')), 's1')).toEqual({ ok: true, code: 'c' });
  });

  it('given a different state, should return state_mismatch and never the code', () => {
    expect(parseCallback(callback('code=c&state=attacker'), 's1')).toEqual({ ok: false, error: { reason: 'state_mismatch' } });
  });

  it('given no state in the callback, should return state_mismatch', () => {
    expect(parseCallback(callback('code=c'), 's1')).toEqual({ ok: false, error: { reason: 'state_mismatch' } });
  });

  it('given an empty expected state, should never match (not even an empty callback state)', () => {
    expect(parseCallback(callback('code=c&state='), '')).toEqual({ ok: false, error: { reason: 'state_mismatch' } });
  });

  it('given a state that differs only in length, should return state_mismatch', () => {
    expect(parseCallback(callback('code=c&state=s1x'), 's1')).toEqual({ ok: false, error: { reason: 'state_mismatch' } });
  });

  it('given a state that only adds a trailing NUL, should return state_mismatch', () => {
    expect(parseCallback(callback('code=c&state=s1%00'), 's1')).toEqual({ ok: false, error: { reason: 'state_mismatch' } });
  });

  it('given a duplicated state parameter, should fail closed with state_mismatch', () => {
    expect(parseCallback(callback('code=c&state=s1&state=s1'), 's1')).toEqual({ ok: false, error: { reason: 'state_mismatch' } });
  });

  it('given a matching state but no code, should return missing_code', () => {
    expect(parseCallback(callback('state=s1'), 's1')).toEqual({ ok: false, error: { reason: 'missing_code' } });
    expect(parseCallback(callback('state=s1&code='), 's1')).toEqual({ ok: false, error: { reason: 'missing_code' } });
  });

  it('given a duplicated code parameter, should fail closed with missing_code', () => {
    expect(parseCallback(callback('state=s1&code=a&code=b'), 's1')).toEqual({ ok: false, error: { reason: 'missing_code' } });
  });

  it('compares state before reading an error, so a forged error redirect is a state_mismatch', () => {
    expect(parseCallback(callback('error=access_denied'), 's1')).toEqual({ ok: false, error: { reason: 'state_mismatch' } });
  });

  it.each(AUTHORIZATION_ERROR_CODES)('passes the RFC 6749 §4.1.2.1 error "%s" through as data', (code) => {
    expect(parseCallback(callback(`error=${code}&state=s1`), 's1')).toEqual({
      ok: false,
      error: { reason: 'authorization_error', error: code, errorDescription: null },
    });
  });

  it('lists exactly the seven RFC 6749 §4.1.2.1 error codes', () => {
    expect([...AUTHORIZATION_ERROR_CODES].sort()).toEqual(
      [
        'access_denied',
        'invalid_request',
        'invalid_scope',
        'server_error',
        'temporarily_unavailable',
        'unauthorized_client',
        'unsupported_response_type',
      ].sort(),
    );
  });

  it('carries a well-formed error_description, and prefers the error over any code that came with it', () => {
    expect(parseCallback(callback('error=invalid_scope&error_description=Scope+not+allowed&code=c&state=s1'), 's1')).toEqual({
      ok: false,
      error: { reason: 'authorization_error', error: 'invalid_scope', errorDescription: 'Scope not allowed' },
    });
  });

  it('drops an error_description outside the RFC 6749 charset or over 256 characters', () => {
    const quote = parseCallback(callback('error=access_denied&error_description=%22quoted%22&state=s1'), 's1');
    const long = parseCallback(callback(`error=access_denied&error_description=${'x'.repeat(257)}&state=s1`), 's1');

    expect(quote).toEqual({ ok: false, error: { reason: 'authorization_error', error: 'access_denied', errorDescription: null } });
    expect(long).toEqual({ ok: false, error: { reason: 'authorization_error', error: 'access_denied', errorDescription: null } });
  });

  it('maps an error value outside RFC 6749 to "unrecognized" instead of echoing attacker text', () => {
    expect(parseCallback(callback('error=Please+call+1-800-SCAM&state=s1'), 's1')).toEqual({
      ok: false,
      error: { reason: 'authorization_error', error: 'unrecognized', errorDescription: null },
    });
  });

  it('never throws: an unparseable URL is a typed malformed_callback', () => {
    expect(parseCallback('not a url', 's1')).toEqual({ ok: false, error: { reason: 'malformed_callback' } });
  });
});

describe('parseTokenResponse', () => {
  it('reads the Bearer pair', () => {
    expect(parseTokenResponse(BEARER_BODY)).toEqual({
      kind: 'oauth',
      accessToken: 'ps_at_new',
      refreshToken: 'ps_rt_new',
      expiresIn: 900,
      scope: 'profile offline_access',
    });
  });

  it('reads an access-only Bearer response (no offline_access, ADR 0003 F1) with no refresh token', () => {
    const { refresh_token: _omitted, ...accessOnly } = BEARER_BODY;
    expect(parseTokenResponse(accessOnly)).toEqual({
      kind: 'oauth',
      accessToken: 'ps_at_new',
      expiresIn: 900,
      scope: 'profile offline_access',
    });
  });

  it('reads the three first-party shapes the CLI relies on', () => {
    expect(parseTokenResponse({ token_type: 'mcp', access_token: 'mcp_x', scope: 'drive:d1:member' })).toEqual({
      kind: 'mcp',
      token: 'mcp_x',
      scope: 'drive:d1:member',
    });
    expect(parseTokenResponse({ token_type: 'mcp_update', token_id: 't1', scope: 'update_key:t1' })).toEqual({
      kind: 'mcp_update',
      tokenId: 't1',
      scope: 'update_key:t1',
    });
    expect(parseTokenResponse({ token_type: 'mcp_activate', token_id: 't1', scope: 'activate_key:t1' })).toEqual({
      kind: 'mcp_activate',
      tokenId: 't1',
      scope: 'activate_key:t1',
    });
  });

  it('returns null for anything else, including a known token_type with a missing field', () => {
    expect(parseTokenResponse(null)).toBeNull();
    expect(parseTokenResponse({ access_token: 'only-this' })).toBeNull();
    expect(parseTokenResponse({ ...BEARER_BODY, token_type: 'bearer' })).toBeNull();
    expect(parseTokenResponse({ token_type: 'mcp_update', scope: 'update_key:t1' })).toBeNull();
    expect(parseTokenResponse({ ...BEARER_BODY, expires_in: '900' })).toBeNull();
  });
});

describe('discoverMetadata', () => {
  const metadata = {
    issuer: 'https://pagespace.ai',
    authorization_endpoint: 'https://pagespace.ai/api/oauth/authorize',
    token_endpoint: TOKEN_ENDPOINT,
    revocation_endpoint: REVOCATION_ENDPOINT,
    device_authorization_endpoint: 'https://pagespace.ai/api/oauth/device_authorization',
  };

  it('reads RFC 8414 metadata from the well-known path under the base URL', async () => {
    const { fetch, requests } = recordingFetch(() => jsonResponse(200, metadata));

    const result = await discoverMetadata('https://pagespace.ai/', { fetch });

    expect(requests.map((r) => r.url)).toEqual(['https://pagespace.ai/.well-known/oauth-authorization-server']);
    expect(result).toEqual({
      issuer: 'https://pagespace.ai',
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOCATION_ENDPOINT,
      deviceAuthorizationEndpoint: 'https://pagespace.ai/api/oauth/device_authorization',
    });
  });

  it('leaves the optional endpoints undefined when the server does not advertise them', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(200, { authorization_endpoint: metadata.authorization_endpoint, token_endpoint: TOKEN_ENDPOINT }),
    );

    const result = await discoverMetadata(BASE_URL, { fetch });

    expect(result.revocationEndpoint).toBeUndefined();
    expect(result.deviceAuthorizationEndpoint).toBeUndefined();
    expect(result.issuer).toBeUndefined();
  });

  it('fails closed on malformed metadata (a missing or non-URL endpoint)', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(200, { issuer: BASE_URL, token_endpoint: 'not a url' }));

    const error = await captureError(discoverMetadata(BASE_URL, { fetch }));

    expect(isResponseValidationError(error)).toBe(true);
  });

  it('classifies a 5xx as a retryable server error', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(503, {}));

    const error = await captureError(discoverMetadata(BASE_URL, { fetch }));

    expect(isServerError(error)).toBe(true);
  });

  it('classifies a network failure as a retryable network error', async () => {
    const error = await captureError(discoverMetadata(BASE_URL, { fetch: throwingFetch('ECONNREFUSED') }));

    expect(isNetworkError(error)).toBe(true);
    expect(classifyRefreshFailure(error)).toBe('retryable');
  });
});

describe('exchangeAuthorizationCode', () => {
  const params = {
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'app_123',
    code: 'ps_ac_secret-code',
    redirectUri: 'https://app.example.com/auth/pagespace/callback',
    codeVerifier: 'v'.repeat(43),
  };

  it('POSTs a form-encoded authorization_code grant with the PKCE verifier and no client secret', async () => {
    const { fetch, requests } = recordingFetch(() => jsonResponse(200, BEARER_BODY));

    const result = await exchangeAuthorizationCode(params, { fetch });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe(TOKEN_ENDPOINT);
    expect(request.method).toBe('POST');
    expect(request.contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(request.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'ps_ac_secret-code',
      redirect_uri: 'https://app.example.com/auth/pagespace/callback',
      client_id: 'app_123',
      code_verifier: 'v'.repeat(43),
    });
    expect(result).toEqual({
      kind: 'oauth',
      accessToken: 'ps_at_new',
      refreshToken: 'ps_rt_new',
      expiresIn: 900,
      scope: 'profile offline_access',
    });
  });

  it('classifies a 400 invalid_grant as terminal, carrying the RFC 6749 error code as its message', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(400, { error: 'invalid_grant' }));

    const error = await captureError(exchangeAuthorizationCode(params, { fetch }));

    expect(classifyRefreshFailure(error)).toBe('terminal');
    expect((error as Error).message).toBe('invalid_grant');
  });

  it('classifies a 429 as retryable and reads the retry delay from the body the token route sends', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(429, { error: 'rate_limited', retryAfter: 30 }));

    const error = await captureError(exchangeAuthorizationCode(params, { fetch }));

    expect(isRateLimitError(error)).toBe(true);
    expect((error as RateLimitError).retryAfterMs).toBe(30_000);
    expect(classifyRefreshFailure(error)).toBe('retryable');
  });

  it('prefers a Retry-After header over the body when both are present', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(429, { error: 'rate_limited', retryAfter: 30 }, { 'Retry-After': '5' }));

    const error = await captureError(exchangeAuthorizationCode(params, { fetch }));

    expect((error as RateLimitError).retryAfterMs).toBe(5_000);
  });

  it('classifies a 5xx and a network failure as retryable', async () => {
    const serverError = await captureError(exchangeAuthorizationCode(params, { fetch: recordingFetch(() => jsonResponse(502, {})).fetch }));
    const networkError = await captureError(exchangeAuthorizationCode(params, { fetch: throwingFetch('ECONNRESET') }));

    expect(classifyRefreshFailure(serverError)).toBe('retryable');
    expect(classifyRefreshFailure(networkError)).toBe('retryable');
  });

  it('fails closed (terminal) on a malformed 2xx body', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(200, { access_token: 'only-this' }));

    const error = await captureError(exchangeAuthorizationCode(params, { fetch }));

    expect(isResponseValidationError(error)).toBe(true);
    expect(classifyRefreshFailure(error)).toBe('terminal');
  });

  it('fails closed on a 2xx body that is not JSON', async () => {
    const { fetch } = recordingFetch(() => new Response('<html>oops</html>', { status: 200 }));

    const error = await captureError(exchangeAuthorizationCode(params, { fetch }));

    expect(isResponseValidationError(error)).toBe(true);
  });

  it('never surfaces the code, the verifier, or a server echo of either in a thrown error', async () => {
    const echo = { error: params.code, error_description: `bad verifier ${params.codeVerifier}` };
    const responses = [jsonResponse(400, echo), jsonResponse(500, echo), jsonResponse(200, { access_token: params.code })];

    for (const response of responses) {
      const error = await captureError(exchangeAuthorizationCode(params, { fetch: recordingFetch(() => response).fetch }));
      const visible = everythingVisible(error);
      expect(visible).not.toContain(params.code);
      expect(visible).not.toContain(params.codeVerifier);
    }
  });
});

describe('refreshWithTokenEndpoint', () => {
  const params = { tokenEndpoint: TOKEN_ENDPOINT, clientId: 'app_123', refreshToken: 'ps_rt_old_secret' };

  it('POSTs a form-encoded refresh_token grant and resolves the rotated pair with absolute expiries', async () => {
    const { fetch, requests } = recordingFetch(() => jsonResponse(200, BEARER_BODY));

    const tokens = await refreshWithTokenEndpoint(params, { fetch, now: () => 1_000_000 });

    expect(requests[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(requests[0].method).toBe('POST');
    expect(Object.fromEntries(requests[0].body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'ps_rt_old_secret',
      client_id: 'app_123',
    });
    expect(tokens).toEqual({
      accessToken: 'ps_at_new',
      accessExpiresAt: 1_000_000 + 900_000,
      refreshToken: 'ps_rt_new',
      refreshExpiresAt: 1_000_000 + 30 * 24 * 60 * 60 * 1000,
      scope: 'profile offline_access',
    });
  });

  it('classifies failures per ADR 0003: 400/401 terminal; 429, 5xx and network retryable', async () => {
    const outcomes = await Promise.all(
      [
        jsonResponse(400, { error: 'invalid_grant' }),
        jsonResponse(401, { error: 'invalid_client' }),
        jsonResponse(429, { error: 'rate_limited' }),
        jsonResponse(503, {}),
      ].map((response) => captureError(refreshWithTokenEndpoint(params, { fetch: recordingFetch(() => response).fetch }))),
    );
    const network = await captureError(refreshWithTokenEndpoint(params, { fetch: throwingFetch('ENOTFOUND') }));

    expect(outcomes.map(classifyRefreshFailure)).toEqual(['terminal', 'terminal', 'retryable', 'retryable']);
    expect(classifyRefreshFailure(network)).toBe('retryable');
  });

  it('fails closed (terminal) when a refresh answer carries no rotated refresh token', async () => {
    const { refresh_token: _omitted, ...accessOnly } = BEARER_BODY;
    const { fetch } = recordingFetch(() => jsonResponse(200, accessOnly));

    const error = await captureError(refreshWithTokenEndpoint(params, { fetch }));

    expect(classifyRefreshFailure(error)).toBe('terminal');
  });

  it('never surfaces the refresh token, even when the server echoes it back', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(400, { error: params.refreshToken, error_description: params.refreshToken }));

    const error = await captureError(refreshWithTokenEndpoint(params, { fetch }));

    expect(everythingVisible(error)).not.toContain(params.refreshToken);
  });
});

describe('createTokenEndpointRefresh', () => {
  it('is the RefreshAccessToken shape OAuthTokenProvider takes, bound to one endpoint and client', async () => {
    const { fetch, requests } = recordingFetch(() => jsonResponse(200, BEARER_BODY));
    const refresh = createTokenEndpointRefresh({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'app_123', fetch, now: () => 0 });

    const tokens = await refresh('ps_rt_old');

    expect(requests[0].url).toBe(TOKEN_ENDPOINT);
    expect(requests[0].body.get('refresh_token')).toBe('ps_rt_old');
    expect(tokens.accessToken).toBe('ps_at_new');
  });
});

describe('revokeToken', () => {
  const params = { revocationEndpoint: REVOCATION_ENDPOINT, token: 'ps_rt_to_revoke', clientId: 'app_123' };

  it('POSTs a form-encoded RFC 7009 revocation and reports a 2xx as revoked', async () => {
    const { fetch, requests } = recordingFetch(() => new Response(null, { status: 200 }));

    const result = await revokeToken(params, { fetch });

    expect(requests[0].url).toBe(REVOCATION_ENDPOINT);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(requests[0].body)).toEqual({ token: 'ps_rt_to_revoke', client_id: 'app_123' });
    expect(result).toEqual({ outcome: 'revoked' });
  });

  it('never throws: 429, 5xx and network failures are retryable results, a 400 is terminal', async () => {
    const rateLimited = await revokeToken(params, { fetch: recordingFetch(() => jsonResponse(429, { error: 'rate_limited', retryAfter: 7 })).fetch });
    const serverError = await revokeToken(params, { fetch: recordingFetch(() => jsonResponse(503, {})).fetch });
    const network = await revokeToken(params, { fetch: throwingFetch('ECONNRESET') });
    const badRequest = await revokeToken(params, { fetch: recordingFetch(() => jsonResponse(400, { error: 'invalid_request' })).fetch });

    expect(rateLimited).toMatchObject({ outcome: 'failed', retryable: true });
    expect(rateLimited.outcome === 'failed' && isRateLimitError(rateLimited.error) && rateLimited.error.retryAfterMs).toBe(7_000);
    expect(serverError).toMatchObject({ outcome: 'failed', retryable: true });
    expect(network.outcome === 'failed' && isNetworkError(network.error)).toBe(true);
    expect(network).toMatchObject({ outcome: 'failed', retryable: true });
    expect(badRequest).toMatchObject({ outcome: 'failed', retryable: false });
  });

  it('never includes the token in a failure result', async () => {
    const result = await revokeToken(params, { fetch: recordingFetch(() => jsonResponse(500, { error: params.token })).fetch });

    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' ? everythingVisible(result.error) : '').not.toContain(params.token);
  });
});

describe('readOAuthErrorCode', () => {
  const params = {
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'app_123',
    code: 'c',
    redirectUri: 'https://app.example.com/cb',
    codeVerifier: 'v'.repeat(43),
  };

  it('reads the RFC 6749 error code off a token-endpoint rejection', async () => {
    const error = await captureError(exchangeAuthorizationCode(params, { fetch: recordingFetch(() => jsonResponse(400, { error: 'invalid_grant' })).fetch }));

    expect(readOAuthErrorCode(error)).toBe('invalid_grant');
  });

  it('is null when the server sent no known code, and for anything that is not a token-endpoint error', async () => {
    const unknown = await captureError(exchangeAuthorizationCode(params, { fetch: recordingFetch(() => jsonResponse(400, { error: 'made_up' })).fetch }));
    const network = await captureError(exchangeAuthorizationCode(params, { fetch: throwingFetch('ECONNRESET') }));

    expect(readOAuthErrorCode(unknown)).toBeNull();
    expect(readOAuthErrorCode(network)).toBeNull();
    expect(readOAuthErrorCode(new Error('invalid_grant'))).toBeNull();
    expect(readOAuthErrorCode('invalid_grant')).toBeNull();
  });
});

describe('token-endpoint timeout', () => {
  it('aborts a hung request and reports a retryable TimeoutError (a stalled refresh must not hold the refresh lock forever)', async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;

    const error = await captureError(
      refreshWithTokenEndpoint({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'app_123', refreshToken: 'ps_rt_x' }, { fetch: hanging, timeoutMs: 20 }),
    );

    expect(isTimeoutError(error)).toBe(true);
    expect(classifyRefreshFailure(error)).toBe('retryable');
  });
});

describe('token-endpoint timeout does not rely on the fetch honouring AbortSignal', () => {
  it('times out a fetch that ignores the signal', async () => {
    const deaf = (() => new Promise<Response>(() => undefined)) as typeof fetch;

    const error = await captureError(
      refreshWithTokenEndpoint({ tokenEndpoint: TOKEN_ENDPOINT, clientId: 'app_123', refreshToken: 'ps_rt_x' }, { fetch: deaf, timeoutMs: 20 }),
    );

    expect(isTimeoutError(error)).toBe(true);
  });

  it('times out a body that never finishes, and reports it as a TimeoutError (not a malformed response)', async () => {
    const stalledBody = (async () =>
      new Response(new ReadableStream({ start: () => undefined }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const error = await captureError(discoverMetadata(BASE_URL, { fetch: stalledBody, timeoutMs: 20 }));

    expect(isTimeoutError(error)).toBe(true);
    expect(classifyRefreshFailure(error)).toBe('retryable');
  });
});
