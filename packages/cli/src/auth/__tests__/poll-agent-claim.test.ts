import { describe, expect, it, vi } from 'vitest';
import { createPollAgentClaim } from '../poll-agent-claim.js';

const ENDPOINT = 'https://pagespace.ai/api/oauth/token';
const PARAMS = { tokenEndpoint: ENDPOINT, claimToken: 'ps_claim_1', clientId: 'pagespace-agent' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createPollAgentClaim', () => {
  it('POSTs the claim grant form-encoded, claim token in the body only', async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: 'authorization_pending' }));
    await createPollAgentClaim(fetchImpl as unknown as typeof fetch)(PARAMS);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('urn:pagespace:agent-auth:grant-type:claim');
    expect(form.get('claim_token')).toBe('ps_claim_1');
    expect(form.get('client_id')).toBe('pagespace-agent');
  });

  it.each(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant'])(
    'maps the %s answer to its own outcome',
    async (code) => {
      const poll = createPollAgentClaim((async () => json(400, { error: code })) as unknown as typeof fetch);
      await expect(poll(PARAMS)).resolves.toEqual({ kind: code });
    },
  );

  it('reports an unknown refusal as request_failed with its code, never throwing', async () => {
    const poll = createPollAgentClaim((async () => json(503, { error: 'temporarily_unavailable' })) as unknown as typeof fetch);
    await expect(poll(PARAMS)).resolves.toEqual({ kind: 'request_failed', message: 'temporarily_unavailable' });
  });

  it('reports a network failure as request_failed', async () => {
    const poll = createPollAgentClaim((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(poll(PARAMS)).resolves.toMatchObject({ kind: 'request_failed' });
  });

  it('returns the owner and the fresh token pair on approval', async () => {
    const poll = createPollAgentClaim(
      (async () =>
        json(200, {
          claimed: true,
          owner: { id: 'user_h', name: 'Ada' },
          access_token: 'ps_at_c',
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'ps_rt_c',
          scope: 'account offline_access',
        })) as unknown as typeof fetch,
      () => 0,
    );

    const result = await poll(PARAMS);
    expect(result).toMatchObject({ kind: 'claimed', owner: { id: 'user_h', name: 'Ada' }, tokens: { refreshToken: 'ps_rt_c' } });
  });

  it('still reports a claim that settled without a token pair', async () => {
    const poll = createPollAgentClaim((async () => json(200, { claimed: true, owner: { id: 'user_h', name: null } })) as unknown as typeof fetch);
    await expect(poll(PARAMS)).resolves.toEqual({ kind: 'claimed', owner: { id: 'user_h', name: null }, tokens: null });
  });

  it('refuses a 200 that is not a claim approval', async () => {
    const poll = createPollAgentClaim((async () => json(200, { hello: 'world' })) as unknown as typeof fetch);
    await expect(poll(PARAMS)).resolves.toEqual({ kind: 'request_failed', message: 'invalid_response' });
  });
});
