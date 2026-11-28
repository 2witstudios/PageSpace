/**
 * POST /api/agent/claim/decision — approve/deny at /claim (Agent Signup Phase 4;
 * mirrors /api/oauth/device_authorization/decision). Session + CSRF, rate
 * limited, door-gated; the frozen decision runs under FOR UPDATE in the
 * repository (real Postgres: agent-claim-flow.integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rateLimit: vi.fn(),
  record: vi.fn(),
  audit: vi.fn(),
  doorOpen: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mocks.auth(...args),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
  getClientIP: () => '203.0.113.7',
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => mocks.rateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { OAUTH_VERIFY: { maxAttempts: 10, windowMs: 300_000 } },
}));
vi.mock('@/lib/repositories/agent-claim-repository', () => ({ recordAgentClaimDecision: (...args: unknown[]) => mocks.record(...args) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.doorOpen(),
}));

import { POST } from '../route';

const SESSION = { tokenType: 'session', userId: 'human-1', role: 'user', tokenVersion: 0, adminRoleVersion: 0, sessionId: 's1' };
const req = (body: unknown) => new Request('https://pagespace.test/api/agent/claim/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/agent/claim/decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(SESSION);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.doorOpen.mockReturnValue(true);
    mocks.record.mockResolvedValue({ outcome: 'approved', agentUserId: 'agent-1' });
  });

  it('given an approval, should record it for the signed-in human and audit auth.agent.claimed', async () => {
    const res = await POST(req({ userCode: 'abcd-efgh', action: 'approve' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'approved' });
    expect(mocks.record).toHaveBeenCalledWith({ userCode: 'ABCDEFGH', action: 'approve', claimerUserId: 'human-1', now: expect.any(Date) });
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['session'], requireCSRF: true });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.agent.claimed', userId: 'human-1', resourceType: 'agent_identity', resourceId: 'agent-1' }));
  });

  it('given a denial, should record it and answer denied', async () => {
    mocks.record.mockResolvedValue({ outcome: 'denied', agentUserId: 'agent-1' });
    const res = await POST(req({ userCode: 'ABCD-EFGH', action: 'deny' }));
    expect(await res.json()).toEqual({ ok: true, action: 'denied' });
    expect(mocks.audit.mock.calls.some(([, e]) => (e as { eventType: string }).eventType === 'auth.agent.claimed')).toBe(false);
  });

  it.each([
    [{ outcome: 'not_found' }],
    [{ outcome: 'refused', agentUserId: 'agent-1', decision: { status: 'already_claimed', ownerUserId: 'human-2' } }],
    [{ outcome: 'refused', agentUserId: 'agent-1', decision: { status: 'already_settled', existingStatus: 'denied' } }],
    [{ outcome: 'refused', agentUserId: 'agent-1', decision: { status: 'expired' } }],
  ])('given %o, should answer the one invalid_code (no oracle on ownership)', async (result) => {
    mocks.record.mockResolvedValue(result);
    const res = await POST(req({ userCode: 'ABCD-EFGH', action: 'approve' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('given a non-human claimer, should answer not_human', async () => {
    mocks.record.mockResolvedValue({ outcome: 'refused', agentUserId: 'agent-1', decision: { status: 'not_human' } });
    const res = await POST(req({ userCode: 'ABCD-EFGH', action: 'approve' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_human' });
  });

  it('given an unknown action, should be invalid_request and record nothing', async () => {
    const res = await POST(req({ userCode: 'ABCD-EFGH', action: 'maybe' }));
    expect(res.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('given a spent rate limit, should 429 and record nothing', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 30 });
    expect((await POST(req({ userCode: 'ABCD-EFGH', action: 'approve' }))).status).toBe(429);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('given the door is closed, should 404', async () => {
    mocks.doorOpen.mockReturnValue(false);
    expect((await POST(req({ userCode: 'ABCD-EFGH', action: 'approve' }))).status).toBe(404);
  });
});
