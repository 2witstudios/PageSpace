import { describe, expect, it, vi } from 'vitest';
import { createPollAgentClaim } from '../poll-agent-claim.js';

const ENDPOINT = 'https://pagespace.ai/api/oauth/token';
const PARAMS = { tokenEndpoint: ENDPOINT, accessToken: 'ps_at_live', clientId: 'pagespace-agent' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createPollAgentClaim', () => {
  // Security review: the claim token is gone; the agent's own access token is the credential.
  it("POSTs the claim grant form-encoded with the agent's own access token as Bearer and no claim token", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: 'authorization_pending' }));
    await createPollAgentClaim(fetchImpl as unknown as typeof fetch)(PARAMS);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ps_at_live');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('urn:pagespace:agent-auth:grant-type:claim');
    expect(form.get('client_id')).toBe('pagespace-agent');
    expect(form.has('claim_token')).toBe(false);
  });

  it.each(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant', 'invalid_token'])(
    'maps the %s answer to its own outcome',
    async (code) => {
      const poll = createPollAgentClaim((async () => json(code === 'invalid_token' ? 401 : 400, { error: code })) as unknown as typeof fetch);
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

  it('returns the owner on approval — and no token, even if a server sent one', async () => {
    const poll = createPollAgentClaim((async () => json(200, { claimed: true, owner: { id: 'user_h', name: 'Ada' }, access_token: 'ps_at_c', refresh_token: 'ps_rt_c' })) as unknown as typeof fetch);
    await expect(poll(PARAMS)).resolves.toEqual({ kind: 'claimed', owner: { id: 'user_h', name: 'Ada' } });
  });

  it('refuses a 200 that is not a claim approval', async () => {
    const poll = createPollAgentClaim((async () => json(200, { hello: 'world' })) as unknown as typeof fetch);
    await expect(poll(PARAMS)).resolves.toEqual({ kind: 'request_failed', message: 'invalid_response' });
  });
});
