/**
 * POST /api/agent/claim — an agent starts its claim (auth.md "Fund"; ADR 0008
 * Decisions 3, 8; Agent Signup Phase 4). The repository is mocked; the
 * real-Postgres ceremony is agent-claim-flow.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  rateLimit: vi.fn(),
  start: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.enabled(),
  agentIssuer: () => 'https://pagespace.test',
}));
vi.mock('@/lib/auth', () => ({ getClientIP: () => '203.0.113.9' }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: { AGENT_CLAIM_INIT: { maxAttempts: 10, windowMs: 300_000 } },
}));
vi.mock('@/lib/repositories/agent-claim-repository', () => ({ startAgentClaim: mocks.start }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } }));

import { POST } from '../route';

const CLAIM = 'ps_claim_abcdefghijklmnopqrstuvwx';

const start = (body: unknown, raw = false) =>
  POST(new Request('https://pagespace.test/api/agent/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  }));

describe('POST /api/agent/claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.rateLimit.mockResolvedValue({ allowed: true, attemptsRemaining: 9 });
    mocks.start.mockResolvedValue({ outcome: 'ok', agentUserId: 'agent-1', userCode: 'ABCD-EFGH', expiresInSeconds: 900, intervalSeconds: 5 });
  });

  it('given a live unclaimed agent\'s claim token, should return the device-flow shaped claim with expires_in 900 and interval 5', async () => {
    const res = await start({ claim_token: CLAIM });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://pagespace.test/claim',
      verification_uri_complete: 'https://pagespace.test/claim?user_code=ABCD-EFGH',
      expires_in: 900,
      interval: 5,
    });
    expect(mocks.start).toHaveBeenCalledWith({ claimToken: CLAIM, now: expect.any(Date) });
  });

  it('given an unknown, claimed or revoked token, should answer the ONE 400 a malformed body also gets', async () => {
    mocks.start.mockResolvedValue({ outcome: 'invalid' });
    const refused = await start({ claim_token: CLAIM });
    const malformed = await start({ nope: true });
    const notJson = await start('{', true);
    expect([refused.status, malformed.status, notJson.status]).toEqual([400, 400, 400]);
    const bodies = await Promise.all([refused.json(), malformed.json(), notJson.json()]);
    expect(bodies).toEqual([{ error: 'invalid_request' }, { error: 'invalid_request' }, { error: 'invalid_request' }]);
  });

  it('given the door is closed, should 404 before any rate limit or lookup', async () => {
    mocks.enabled.mockReturnValue(false);
    const res = await start({ claim_token: CLAIM });
    expect(res.status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('given the per-IP AGENT_CLAIM_INIT bucket is spent, should 429 and mint nothing', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 42 });
    const res = await start({ claim_token: CLAIM });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.rateLimit.mock.calls[0]?.[0]).toBe('agent-claim-init:ip:203.0.113.9');
  });

  it('given the per-token bucket is spent, should 429 and mint nothing (one agent cannot flood the user-code space from many IPs)', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, retryAfter: 7 });
    const res = await start({ claim_token: CLAIM });
    expect(res.status).toBe(429);
    expect(mocks.start).not.toHaveBeenCalled();
    const tokenKey = String(mocks.rateLimit.mock.calls[1]?.[0]);
    expect(tokenKey.startsWith('agent-claim-init:token:')).toBe(true);
    // The bucket key never carries the token itself.
    expect(tokenKey).not.toContain(CLAIM);
  });

  it('never echoes the claim token into an audit row', async () => {
    await start({ claim_token: CLAIM });
    mocks.start.mockResolvedValue({ outcome: 'invalid' });
    await start({ claim_token: CLAIM });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(CLAIM);
  });

  it('given a database failure, should answer a constant 503 with nothing bound in it', async () => {
    const dbError = Object.assign(new Error(`Failed query: select … params: ${CLAIM}`), { name: 'DrizzleQueryError', cause: Object.assign(new Error('x'), { code: '57P01' }) });
    mocks.start.mockRejectedValue(dbError);
    const res = await start({ claim_token: CLAIM });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});
