/**
 * POST /api/oauth/token — the claim grant (auth.md "Fund"; ADR 0008 Decisions
 * 3, 5, 7 and the security review addendum). The AGENT polls with its own
 * `pagespace-agent` access token as Bearer; on approval the answer is
 * `{claimed:true, owner:{id,name}}` — NEVER a token pair (the agent keeps its
 * own tokens, Decision 7). A claim token is not a credential here at all. The
 * real static client registry and the real caller classification are used;
 * the repositories are mocked (the real-Postgres ceremony is
 * agent-claim-flow.integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  ensureOAuthClientRow: vi.fn(),
  pollAgentClaim: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  doorOpen: vi.fn(),
  auth: vi.fn(),
  issuance: vi.fn(),
  accountType: vi.fn(),
}));

vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: mocks.ensureOAuthClientRow,
  exchangeAuthorizationCode: vi.fn(),
  refreshTokenGrant: vi.fn(),
  pollDeviceToken: vi.fn(),
  exchangeAgentAssertion: vi.fn(),
  findRefreshTokenFamilyId: vi.fn(),
  findAccessTokenIssuance: mocks.issuance,
}));
vi.mock('@/lib/repositories/session-repository', () => ({ sessionRepository: { findAccountType: mocks.accountType } }));
vi.mock('@/lib/repositories/agent-claim-repository', () => ({ pollAgentClaim: mocks.pollAgentClaim }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/onboarding/home-drive', () => ({ provisionHomeDriveIfNeeded: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(), logTokenActivity: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getClientIP: () => '203.0.113.21',
  authenticateRequestWithOptions: mocks.auth,
  isAuthError: (value: unknown) => Boolean((value as { error?: unknown })?.error),
}));
vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.doorOpen(),
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: {
    OAUTH_TOKEN_EXCHANGE: { maxAttempts: 10, windowMs: 300_000 },
    OAUTH_DEVICE_POLL: { maxAttempts: 100, windowMs: 300_000 },
    AGENT_TOKEN_IP: { maxAttempts: 60, windowMs: 300_000 },
    AGENT_TOKEN_CREDENTIAL: { maxAttempts: 10, windowMs: 300_000 },
  },
}));

import { POST } from '../route';

const GRANT = 'urn:pagespace:agent-auth:grant-type:claim';
const BEARER = 'ps_at_' + 'c'.repeat(43);

/** The agent's own access token, minted by its jwt-bearer grant. */
const agentAuth = { userId: 'agent-1', tokenType: 'oauth', tokenId: 'at-1', role: 'user', tokenVersion: 1, scopes: { account: true } };

function tokenRequest(fields: Record<string, string | undefined>, bearer: string | null = BEARER): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  return new Request('http://web.local/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body.toString(),
  });
}

const fields = (overrides: Record<string, string | undefined> = {}) => ({ grant_type: GRANT, client_id: 'pagespace-agent', ...overrides });
const poll = async (overrides: Record<string, string | undefined> = {}, bearer: string | null = BEARER) => {
  const res = await POST(tokenRequest(fields(overrides), bearer) as never);
  return { status: res.status, body: await res.json() as Record<string, unknown>, cacheControl: res.headers.get('cache-control'), wwwAuthenticate: res.headers.get('www-authenticate') };
};

describe('POST /api/oauth/token — claim grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.doorOpen.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.ensureOAuthClientRow.mockResolvedValue('client-db-agent');
    mocks.pollAgentClaim.mockResolvedValue({ outcome: 'authorization_pending' });
    mocks.auth.mockResolvedValue(agentAuth);
    mocks.issuance.mockResolvedValue({ clientId: 'pagespace-agent', accountType: 'agent' });
    mocks.accountType.mockResolvedValue('agent');
  });

  it('given an approved claim, should answer claimed:true and the owner — and NO token of any kind', async () => {
    mocks.pollAgentClaim.mockResolvedValue({ outcome: 'ok', agentUserId: 'agent-1', owner: { id: 'human-1', name: 'Ada' } });
    const { status, body, cacheControl } = await poll();
    expect(status).toBe(200);
    expect(cacheControl).toBe('no-store');
    expect(body).toEqual({ claimed: true, owner: { id: 'human-1', name: 'Ada' } });
    for (const key of ['access_token', 'refresh_token', 'token_type', 'expires_in', 'scope']) expect(body).not.toHaveProperty(key);
    // The claim polled is the CALLER's own, found by its own id — never by a presented token.
    expect(mocks.pollAgentClaim).toHaveBeenCalledWith({ agentUserId: 'agent-1', now: expect.any(Date) });
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['oauth'], requireCSRF: false });
  });

  it.each([
    ['authorization_pending', { error: 'authorization_pending' }],
    ['slow_down', { error: 'slow_down' }],
    ['expired_token', { error: 'expired_token' }],
    ['access_denied', { error: 'access_denied' }],
  ])('given %s, should answer the device-flow vocabulary', async (outcome, expected) => {
    mocks.pollAgentClaim.mockResolvedValue({ outcome });
    const { status, body } = await poll();
    expect(status).toBe(400);
    expect(body).toEqual(expected);
  });

  it.each([
    [{ outcome: 'not_found' }],
    [{ outcome: 'already_redeemed' }],
    [{ outcome: 'agent_unavailable', agentUserId: 'agent-1' }],
  ])('given %o (no claim, a second poll after redemption, a revoked agent), should answer the one invalid_grant', async (result) => {
    mocks.pollAgentClaim.mockResolvedValue(result);
    const { status, body } = await poll();
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_grant' });
  });

  describe('only the agent itself may poll (security review: the claim token was an agent-takeover credential)', () => {
    it('given a claim_token and no bearer — the old exploit — should refuse, poll nothing and mint nothing', async () => {
      const { status, body } = await poll({ claim_token: 'ps_claim_abcdefghijklmnopqrstuvwx' }, null);
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'invalid_request' });
      expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
      expect(mocks.auth).not.toHaveBeenCalled();
    });

    it('given a claim_token even beside a valid agent bearer, should refuse it: the parameter is not part of the grant', async () => {
      const { status, body } = await poll({ claim_token: 'ps_claim_abcdefghijklmnopqrstuvwx' });
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'invalid_request' });
      expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
    });

    it('given no bearer at all, should answer 401 invalid_token with a Bearer challenge', async () => {
      const { status, body, wwwAuthenticate } = await poll({}, null);
      expect(status).toBe(401);
      expect(body).toEqual({ error: 'invalid_token' });
      expect(wwwAuthenticate).toBe('Bearer error="invalid_token"');
      expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
    });

    it('given an invalid or expired bearer, should answer the same 401 invalid_token', async () => {
      mocks.auth.mockResolvedValue({ error: new Response(null, { status: 401 }) });
      const { status, body } = await poll();
      expect(status).toBe(401);
      expect(body).toEqual({ error: 'invalid_token' });
      expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
    });

    it.each([
      ["a HUMAN's token (a throwaway approver, or the former owner)", { ...agentAuth, userId: 'human-1' }, { clientId: 'pagespace-cli', accountType: 'human' }],
      ["the agent's token held by ANOTHER client", agentAuth, { clientId: 'some-app', accountType: 'agent' }],
      ['a narrow (non-account) agent token', { ...agentAuth, scopes: { account: false } }, { clientId: 'pagespace-agent', accountType: 'agent' }],
    ])('given %s, should answer 401 invalid_token and poll nothing', async (_label, auth, issuance) => {
      mocks.auth.mockResolvedValue(auth);
      mocks.issuance.mockResolvedValue(issuance);
      const { status, body } = await poll();
      expect(status).toBe(401);
      expect(body).toEqual({ error: 'invalid_token' });
      expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
    });
  });

  it('given a missing client_id, should be invalid_request before any lookup', async () => {
    expect((await poll({ client_id: undefined })).body).toEqual({ error: 'invalid_request' });
    expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
  });

  it('given the CLI client, should refuse as unauthorized_client and never authenticate or poll', async () => {
    const { body } = await poll({ client_id: 'pagespace-cli' });
    expect(body).toEqual({ error: 'unauthorized_client' });
    expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
  });

  it('given an unknown client, should be invalid_grant', async () => {
    expect((await poll({ client_id: 'nope' })).body).toEqual({ error: 'invalid_grant' });
    expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
  });

  it('given the door is closed, should not speak the grant at all', async () => {
    mocks.doorOpen.mockReturnValue(false);
    expect((await poll()).body).toEqual({ error: 'unsupported_grant_type' });
    expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
  });

  it('given the device-poll limit is spent, should answer slow_down (RFC 8628 shape) and not poll — keyed per IP and per agent, never per client', async () => {
    mocks.rateLimit.mockImplementation(async (key: string) => ({ allowed: !key.includes(':agent:') }));
    const { status, body } = await poll();
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'slow_down' });
    expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
    const keys = mocks.rateLimit.mock.calls.map((call) => String(call[0]));
    expect(keys).toContain('oauth-token:agent_claim_poll:ip:203.0.113.21');
    expect(keys).toContain('oauth-token:agent_claim_poll:agent:agent-1');
    expect(keys.some((k) => k.includes('client:pagespace-agent'))).toBe(false);
    expect(keys.join(' ')).not.toContain(BEARER);
    for (const call of mocks.rateLimit.mock.calls) expect(call[1]).toEqual({ maxAttempts: 100, windowMs: 300_000 });
  });

  it('given the per-IP poll limit is spent, should answer slow_down before authenticating anything', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    expect((await poll()).body).toEqual({ error: 'slow_down' });
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
