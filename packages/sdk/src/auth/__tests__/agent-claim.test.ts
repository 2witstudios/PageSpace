/**
 * `pollAgentClaim` — the auth.md "Fund" poll (ADR 0008 security review
 * addendum): the agent polls the claim grant with its OWN access token as
 * Bearer. The answer is the device-flow vocabulary until a human decides, then
 * `{claimed:true, owner}` — never a token pair, and no claim token is sent.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_CLAIM_GRANT_TYPE, PAGESPACE_AGENT_CLIENT_ID } from '../agent-assertion.js';
import { pollAgentClaim } from '../agent-claim.js';

const TOKEN_ENDPOINT = 'https://pagespace.ai/api/oauth/token';
const ACCESS = 'ps_at_agentaccess';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const poll = (fetchImpl: ReturnType<typeof vi.fn>) =>
  pollAgentClaim(TOKEN_ENDPOINT, ACCESS, PAGESPACE_AGENT_CLIENT_ID, { fetch: fetchImpl as unknown as typeof fetch });

describe('pollAgentClaim', () => {
  it("POSTs the claim grant form-encoded with the agent's own access token as Bearer, and no claim token", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: 'authorization_pending' }));
    await poll(fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS}`);
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe(AGENT_CLAIM_GRANT_TYPE);
    expect(form.get('client_id')).toBe('pagespace-agent');
    expect(form.has('claim_token')).toBe(false);
  });

  it.each(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant'] as const)(
    'given 400 %s, should answer that kind',
    async (error) => {
      await expect(poll(vi.fn(async () => json(400, { error })))).resolves.toEqual({ kind: error });
    },
  );

  it('given 401 invalid_token, should tell the caller its access token is not usable', async () => {
    await expect(poll(vi.fn(async () => json(401, { error: 'invalid_token' })))).resolves.toEqual({ kind: 'invalid_token' });
  });

  it('given an approval, should answer claimed with the owner', async () => {
    const result = await poll(vi.fn(async () => json(200, { claimed: true, owner: { id: 'human-1', name: 'Ada' } })));
    expect(result).toEqual({ kind: 'claimed', owner: { id: 'human-1', name: 'Ada' } });
  });

  it('given an approval body that also carried tokens (a misbehaving server), should never surface them', async () => {
    const result = await poll(vi.fn(async () => json(200, { claimed: true, owner: { id: 'h', name: 'H' }, access_token: 'ps_at_x', refresh_token: 'ps_rt_x' })));
    expect(result).toEqual({ kind: 'claimed', owner: { id: 'h', name: 'H' } });
  });

  it('given a 200 that is not a claim, should be request_failed', async () => {
    await expect(poll(vi.fn(async () => json(200, { ok: true })))).resolves.toEqual({ kind: 'request_failed', message: 'invalid_response' });
  });

  it('given an unknown error or a network failure, should be request_failed and never throw', async () => {
    await expect(poll(vi.fn(async () => json(503, { error: 'temporarily_unavailable' })))).resolves.toEqual({ kind: 'request_failed', message: 'temporarily_unavailable' });
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(poll(failing)).resolves.toEqual({ kind: 'request_failed', message: 'network_error: offline' });
  });
});
