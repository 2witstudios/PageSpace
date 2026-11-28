/**
 * POST /api/oauth/token — the claim grant (auth.md "Fund"; ADR 0008 Decisions
 * 3, 5, 7; Agent Signup Phase 4). The agent polls with its claim token; on
 * approval it receives `{claimed:true, owner:{id,name}, ...tokens}` minted for
 * ITSELF. The real static client registry is used; the repository is mocked
 * (the real-Postgres ceremony is agent-claim-flow.integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  ensureOAuthClientRow: vi.fn(),
  pollAgentClaim: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  doorOpen: vi.fn(),
}));

vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: mocks.ensureOAuthClientRow,
  exchangeAuthorizationCode: vi.fn(),
  refreshTokenGrant: vi.fn(),
  pollDeviceToken: vi.fn(),
  exchangeAgentAssertion: vi.fn(),
  findRefreshTokenFamilyId: vi.fn(),
}));
vi.mock('@/lib/repositories/agent-claim-repository', () => ({ pollAgentClaim: mocks.pollAgentClaim }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/onboarding/home-drive', () => ({ provisionHomeDriveIfNeeded: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(), logTokenActivity: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getClientIP: () => '203.0.113.21' }));
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
const CLAIM = 'ps_claim_abcdefghijklmnopqrstuvwx';

const tokens = { accessToken: 'ps_at_' + 'a'.repeat(43), refreshToken: 'ps_rt_' + 'b'.repeat(43), familyId: 'family-1' };

function tokenRequest(fields: Record<string, string | undefined>): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  return new Request('http://web.local/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

const fields = (overrides: Record<string, string | undefined> = {}) => ({ grant_type: GRANT, claim_token: CLAIM, client_id: 'pagespace-agent', ...overrides });
const poll = async (overrides: Record<string, string | undefined> = {}) => {
  const res = await POST(tokenRequest(fields(overrides)) as never);
  return { status: res.status, body: await res.json() as Record<string, unknown>, cacheControl: res.headers.get('cache-control') };
};

describe('POST /api/oauth/token — claim grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.doorOpen.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.ensureOAuthClientRow.mockResolvedValue('client-db-agent');
    mocks.pollAgentClaim.mockResolvedValue({ outcome: 'authorization_pending' });
  });

  it('given an approved claim, should answer claimed:true, the owner, and a token pair for the agent', async () => {
    mocks.pollAgentClaim.mockResolvedValue({ outcome: 'ok', agentUserId: 'agent-1', owner: { id: 'human-1', name: 'Ada' }, scopes: ['account', 'offline_access'], tokens });
    const { status, body, cacheControl } = await poll();
    expect(status).toBe(200);
    expect(cacheControl).toBe('no-store');
    expect(body).toEqual({
      claimed: true,
      owner: { id: 'human-1', name: 'Ada' },
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: tokens.refreshToken,
      scope: 'account offline_access',
    });
    // Scoped exactly as the agent's own jwt-bearer grant: account + offline_access.
    expect(mocks.pollAgentClaim).toHaveBeenCalledWith({ claimToken: CLAIM, clientDbId: 'client-db-agent', scopes: ['account', 'offline_access'], now: expect.any(Date) });
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
  ])('given %o (unknown token, a second poll after redemption, a revoked agent), should answer the one invalid_grant', async (result) => {
    mocks.pollAgentClaim.mockResolvedValue(result);
    const { status, body } = await poll();
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_grant' });
  });

  it('given a missing claim_token or client_id, should be invalid_request before any lookup', async () => {
    expect((await poll({ claim_token: undefined })).body).toEqual({ error: 'invalid_request' });
    expect((await poll({ client_id: undefined })).body).toEqual({ error: 'invalid_request' });
    expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
  });

  it('given the CLI client, should refuse as unauthorized_client and never look the token up', async () => {
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

  it('given the device-poll limit is spent, should answer slow_down (RFC 8628 shape) and not poll — keyed per IP and per claim token, never per client', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false }).mockResolvedValueOnce({ allowed: true });
    const { status, body } = await poll();
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'slow_down' });
    expect(mocks.pollAgentClaim).not.toHaveBeenCalled();
    const keys = mocks.rateLimit.mock.calls.map((call) => String(call[0]));
    expect(keys.some((k) => k.includes(':ip:'))).toBe(true);
    expect(keys.some((k) => k.includes(':claim:'))).toBe(true);
    expect(keys.some((k) => k.includes('client:pagespace-agent'))).toBe(false);
    expect(keys.join(' ')).not.toContain(CLAIM);
    for (const call of mocks.rateLimit.mock.calls) expect(call[1]).toEqual({ maxAttempts: 100, windowMs: 300_000 });
  });
});
