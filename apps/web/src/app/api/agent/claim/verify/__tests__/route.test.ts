/**
 * POST /api/agent/claim/verify — the /claim screen's read-only lookup (Agent
 * Signup Phase 4; mirrors /api/oauth/device_authorization/verify). Session
 * only, rate-limited per IP and per session, door-gated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rateLimit: vi.fn(),
  verify: vi.fn(),
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
vi.mock('@/lib/repositories/agent-claim-repository', () => ({ verifyAgentClaimUserCode: (...args: unknown[]) => mocks.verify(...args) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => mocks.doorOpen(),
}));

import { POST } from '../route';

const SESSION = { tokenType: 'session', userId: 'human-1', role: 'user', tokenVersion: 0, adminRoleVersion: 0, sessionId: 's1' };
const req = (body: unknown) => new Request('https://pagespace.test/api/agent/claim/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/agent/claim/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(SESSION);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.doorOpen.mockReturnValue(true);
    mocks.verify.mockResolvedValue({ outcome: 'ok', agent: { agentUserId: 'agent-1', name: 'Scratch', createdAt: new Date('2026-11-01T10:00:00Z'), source: 'claude-code' } });
  });

  it('given a pending code, should name the agent (name, created, source) for the consent screen', async () => {
    const res = await POST(req({ userCode: 'abcd-efgh' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userCode: 'ABCDEFGH',
      agent: { name: 'Scratch', createdAt: '2026-11-01T10:00:00.000Z', source: 'claude-code' },
    });
    expect(mocks.verify).toHaveBeenCalledWith({ userCode: 'ABCDEFGH', claimerUserId: 'human-1', now: expect.any(Date) });
    // Session only — a bearer token can never verify (or later approve) a claim.
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['session'], requireCSRF: false });
  });

  it('given an unknown or settled code, should answer the one invalid_code', async () => {
    mocks.verify.mockResolvedValue({ outcome: 'not_found' });
    const res = await POST(req({ userCode: 'ABCD-EFGH' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('given a signed-in AGENT, should say only a person can claim (a fact about the caller, not the code)', async () => {
    mocks.verify.mockResolvedValue({ outcome: 'not_human' });
    const res = await POST(req({ userCode: 'ABCD-EFGH' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_human' });
  });

  it('given a spent rate limit, should 429 before any lookup', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 30 });
    const res = await POST(req({ userCode: 'ABCD-EFGH' }));
    expect(res.status).toBe(429);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('given a malformed body, should be invalid_request', async () => {
    const res = await POST(req({ userCode: '' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('given the door is closed, should 404', async () => {
    mocks.doorOpen.mockReturnValue(false);
    expect((await POST(req({ userCode: 'ABCD-EFGH' }))).status).toBe(404);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
