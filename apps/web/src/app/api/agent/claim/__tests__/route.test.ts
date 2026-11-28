/**
 * POST /api/agent/claim — an agent starts its OWN claim with its own
 * `pagespace-agent` access token as Bearer (auth.md "Fund"; ADR 0008 Decisions
 * 3, 8; security review addendum). A claim token is no credential: neither
 * alone nor beside a bearer can it start anything. The real caller
 * classification (`resolveClaimCaller` → `decideClaimCaller`) runs; the
 * repositories are mocked. The real-Postgres ceremony is
 * agent-claim-flow.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  rateLimit: vi.fn(),
  start: vi.fn(),
  audit: vi.fn(),
  auth: vi.fn(),
  issuance: vi.fn(),
  accountType: vi.fn(),
  StoreError: class AgentIdentityStoreError extends Error {
    constructor(readonly operation: string, readonly redacted: { errorName: string; code: string | null; constraint: string | null }) {
      super(`Agent identity store failed: ${operation}`);
    }
  },
}));

vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.enabled(),
  agentIssuer: () => 'https://pagespace.test',
}));
vi.mock('@/lib/auth', () => ({
  getClientIP: () => '203.0.113.9',
  authenticateRequestWithOptions: mocks.auth,
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));
vi.mock('@/lib/repositories/oauth-repository', () => ({ findAccessTokenIssuance: mocks.issuance }));
vi.mock('@/lib/repositories/session-repository', () => ({ sessionRepository: { findAccountType: mocks.accountType } }));
vi.mock('@/lib/agent-auth/claim-start', () => ({ startOwnAgentClaim: mocks.start }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: { AGENT_CLAIM_INIT: { maxAttempts: 10, windowMs: 300_000 } },
}));
vi.mock('@pagespace/lib/services/agent-identities', () => ({ AgentIdentityStoreError: mocks.StoreError }));

import { POST } from '../route';

const BEARER = 'ps_at_' + 'a'.repeat(43);
const agentAuth = { userId: 'agent-1', tokenType: 'oauth', tokenId: 'at-1', role: 'user', tokenVersion: 1, scopes: { account: true } };

const start = (body?: unknown, raw = false) =>
  POST(new Request('https://pagespace.test/api/agent/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
    ...(body === undefined ? {} : { body: raw ? (body as string) : JSON.stringify(body) }),
  }));

describe('POST /api/agent/claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 9 });
    mocks.auth.mockResolvedValue(agentAuth);
    mocks.issuance.mockResolvedValue({ clientId: 'pagespace-agent', accountType: 'agent' });
    mocks.accountType.mockResolvedValue('agent');
    mocks.start.mockResolvedValue({ ok: true, userCode: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 900_000) });
  });

  it("given the agent's own access token, should start a claim for the CALLER and return the device-flow shaped answer", async () => {
    const res = await start();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://pagespace.test/claim',
      verification_uri_complete: 'https://pagespace.test/claim?user_code=ABCD-EFGH',
      expires_in: 900,
      interval: 5,
    });
    expect(mocks.start).toHaveBeenCalledWith({ agentUserId: 'agent-1', now: expect.any(Date) });
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), { allow: ['oauth'], requireCSRF: false });
  });

  it('given an empty JSON object body, should start the claim the same way', async () => {
    expect((await start({})).status).toBe(200);
  });

  it('should audit the start without the user code', async () => {
    await start();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write', userId: 'agent-1', resourceType: 'agent_claim' }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('ABCD-EFGH');
  });

  describe('only the agent itself can start its claim (security review: the claim token was an agent-takeover credential)', () => {
    it('given a claim_token and no bearer — the old exploit — should refuse with the auth error and start nothing', async () => {
      mocks.auth.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
      const res = await POST(new Request('https://pagespace.test/api/agent/claim', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim_token: 'ps_claim_abcdefghijklmnopqrstuvwx' }),
      }));
      expect(res.status).toBe(401);
      expect(mocks.start).not.toHaveBeenCalled();
    });

    it('given a claim_token beside a valid agent bearer, should refuse 400: the body takes nothing', async () => {
      const res = await start({ claim_token: 'ps_claim_abcdefghijklmnopqrstuvwx' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
      expect(mocks.start).not.toHaveBeenCalled();
    });

    it('given a malformed body, should refuse 400', async () => {
      expect((await start('{', true)).status).toBe(400);
      expect(mocks.start).not.toHaveBeenCalled();
    });

    it.each([
      ["a HUMAN's account token (a throwaway approver, a former owner)", { ...agentAuth, userId: 'human-1' }, { clientId: 'pagespace-cli', accountType: 'human' }],
      ["the agent's token held by ANOTHER client", agentAuth, { clientId: 'some-app', accountType: 'agent' }],
      ["a human's token even if minted for pagespace-agent", { ...agentAuth, userId: 'human-1' }, { clientId: 'pagespace-agent', accountType: 'human' }],
      ['a narrow (non-account) agent token', { ...agentAuth, scopes: { account: false } }, { clientId: 'pagespace-agent', accountType: 'agent' }],
    ])('given %s, should answer the one 404 and start nothing', async (_label, auth, issuance) => {
      mocks.auth.mockResolvedValue(auth);
      mocks.issuance.mockResolvedValue(issuance);
      const res = await start();
      expect(res.status).toBe(404);
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason: 'not_the_agent_itself', door: 'bearer' }) }));
    });
  });

  it('given the door is closed, should 404 before any rate limit or authentication', async () => {
    mocks.enabled.mockReturnValue(false);
    const res = await start();
    expect(res.status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it('given the per-IP AGENT_CLAIM_INIT bucket is spent, should 429 before authenticating', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });
    const res = await start();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith('agent-claim-init:ip:203.0.113.9', { maxAttempts: 10, windowMs: 300_000 });
  });

  it('should also limit per AGENT — the bucket the session door shares', async () => {
    mocks.rateLimit.mockImplementation(async (key: string) => ({ allowed: !key.startsWith('agent-claim-init:agent:') }));
    const res = await start();
    expect(res.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith('agent-claim-init:agent:agent-1', { maxAttempts: 10, windowMs: 300_000 });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('given the agent already has an owner, should 409 already_claimed', async () => {
    mocks.start.mockResolvedValue({ ok: false, error: 'already_claimed' });
    const res = await start();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_claimed' });
  });

  it('given a revoked or suspended agent, should 404', async () => {
    mocks.start.mockResolvedValue({ ok: false, error: 'not_claimable' });
    expect((await start()).status).toBe(404);
  });

  it('given a store failure, should answer a constant 503', async () => {
    mocks.start.mockRejectedValue(new mocks.StoreError('start_claim', { errorName: 'x', code: null, constraint: null }));
    const res = await start();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});
