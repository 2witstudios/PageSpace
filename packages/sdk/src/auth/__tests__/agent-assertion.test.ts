/**
 * `exchangeAgentAssertion` — the auth.md "Exchange" step: an agent's opaque
 * `ps_agent_*` secret for a `ps_at_`/`ps_rt_` pair, over the RFC 7523 URN
 * the server registers for the `pagespace-agent` client.
 */
import { describe, expect, it, vi } from 'vitest';
import { classifyRefreshFailure } from '../decide.js';
import {
  AGENT_ASSERTION_GRANT_TYPE,
  AGENT_CLAIM_GRANT_TYPE,
  PAGESPACE_AGENT_CLIENT_ID,
  exchangeAgentAssertion,
  isInvalidGrantError,
} from '../agent-assertion.js';

const TOKEN_ENDPOINT = 'https://pagespace.ai/api/oauth/token';
const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SUCCESS = {
  access_token: 'ps_at_1',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'ps_rt_1',
  scope: 'account offline_access',
};

describe('exchangeAgentAssertion', () => {
  it('POSTs the jwt-bearer grant form-encoded with the secret as the assertion', async () => {
    const fetchImpl = vi.fn(async () => json(200, SUCCESS));

    await exchangeAgentAssertion(TOKEN_ENDPOINT, SECRET, PAGESPACE_AGENT_CLIENT_ID, { fetch: fetchImpl as unknown as typeof fetch });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')).toBe(SECRET);
    expect(form.get('client_id')).toBe('pagespace-agent');
    expect(form.has('scope')).toBe(false);
  });

  it('returns OAuthTokens with absolute expiries from the injected clock, and the granted scope', async () => {
    const tokens = await exchangeAgentAssertion(TOKEN_ENDPOINT, SECRET, PAGESPACE_AGENT_CLIENT_ID, {
      fetch: (async () => json(200, SUCCESS)) as unknown as typeof fetch,
      now: () => 1_000,
    });

    expect(tokens).toMatchObject({
      accessToken: 'ps_at_1',
      accessExpiresAt: 1_000 + 900_000,
      refreshToken: 'ps_rt_1',
      scope: 'account offline_access',
    });
    expect(tokens.refreshExpiresAt).toBeGreaterThan(tokens.accessExpiresAt);
  });

  it('classifies a refused secret as a terminal invalid_grant', async () => {
    const error = await exchangeAgentAssertion(TOKEN_ENDPOINT, SECRET, PAGESPACE_AGENT_CLIENT_ID, {
      fetch: (async () => json(400, { error: 'invalid_grant' })) as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(isInvalidGrantError(error)).toBe(true);
    expect(classifyRefreshFailure(error)).toBe('terminal');
  });

  it('keeps a 429 and a 5xx retryable', async () => {
    for (const status of [429, 503]) {
      const error = await exchangeAgentAssertion(TOKEN_ENDPOINT, SECRET, PAGESPACE_AGENT_CLIENT_ID, {
        fetch: (async () => json(status, { error: 'x' })) as unknown as typeof fetch,
      }).catch((caught: unknown) => caught);
      expect(classifyRefreshFailure(error)).toBe('retryable');
      expect(isInvalidGrantError(error)).toBe(false);
    }
  });

  it('maps a transport failure to a NetworkError that never carries the secret', async () => {
    const error = await exchangeAgentAssertion(TOKEN_ENDPOINT, SECRET, PAGESPACE_AGENT_CLIENT_ID, {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    }).catch((caught: unknown) => caught as Error);

    expect((error as { code?: string }).code).toBe('NETWORK_ERROR');
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it('rejects a 200 that is not a Bearer token pair (fail closed)', async () => {
    const error = await exchangeAgentAssertion(TOKEN_ENDPOINT, SECRET, PAGESPACE_AGENT_CLIENT_ID, {
      fetch: (async () => json(200, { token_type: 'mcp', access_token: 'mcp_x', scope: '' })) as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
  });
});

describe('isInvalidGrantError', () => {
  it('is false for non-errors and for other 400s', () => {
    expect(isInvalidGrantError(null)).toBe(false);
    expect(isInvalidGrantError(new Error('invalid_grant'))).toBe(false);
  });
});

describe('agent grant constants', () => {
  it('names the two agent grants and the agent client exactly as auth.md does', () => {
    expect(AGENT_ASSERTION_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(AGENT_CLAIM_GRANT_TYPE).toBe('urn:pagespace:agent-auth:grant-type:claim');
    expect(PAGESPACE_AGENT_CLIENT_ID).toBe('pagespace-agent');
  });
});
