/**
 * POST /api/agent/claim/session — an agent signed in by SESSION gets a claim
 * link for a human (Agent Signup Phase 3; the claim_token-holding API path is
 * Phase 4's POST /api/agent/claim).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  auth: vi.fn(),
  findUser: vi.fn(),
  rateLimit: vi.fn(),
  start: vi.fn(),
  audit: vi.fn(),
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
  authenticateRequestWithOptions: mocks.auth,
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));
vi.mock('@/lib/repositories/auth-repository', () => ({ authRepository: { findUserById: mocks.findUser } }));
vi.mock('@/lib/agent-auth/claim-start', () => ({ startAgentClaimForSession: mocks.start }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mocks.audit }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mocks.rateLimit,
  DISTRIBUTED_RATE_LIMITS: { AGENT_CLAIM_INIT: { maxAttempts: 10, windowMs: 300_000 } },
}));
vi.mock('@pagespace/lib/services/agent-identities', () => ({ AgentIdentityStoreError: mocks.StoreError }));

import { POST } from '../route';

const call = () => POST(new Request('https://pagespace.test/api/agent/claim/session', { method: 'POST' }));

describe('POST /api/agent/claim/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.auth.mockResolvedValue({ userId: 'agent-1', tokenType: 'session' });
    mocks.findUser.mockResolvedValue({ id: 'agent-1', accountType: 'agent' });
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.start.mockResolvedValue({ ok: true, userCode: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 900_000) });
  });

  it('should authenticate a SESSION only, with CSRF', async () => {
    await call();
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), { allow: ['session'], requireCSRF: true });
  });

  it('given an unclaimed agent, should return the device-flow-shaped claim link, no-store', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://pagespace.test/claim',
      verification_uri_complete: 'https://pagespace.test/claim?user_code=ABCD-EFGH',
      expires_in: 900,
      interval: 5,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.start).toHaveBeenCalledWith({ agentUserId: 'agent-1', now: expect.any(Date) });
  });

  it('should audit the claim start without the user code', async () => {
    await call();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', userId: 'agent-1', resourceType: 'agent_identity' }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('ABCD-EFGH');
  });

  it('given the door is closed, should 404 before authenticating', async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await call()).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it('given no session, should return the auth error', async () => {
    mocks.auth.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await call()).status).toBe(401);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('given a human session, should 404 (only an agent can be claimed)', async () => {
    mocks.findUser.mockResolvedValue({ id: 'human-1', accountType: 'human' });
    expect((await call()).status).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it('should rate-limit with AGENT_CLAIM_INIT keyed on the agent', async () => {
    await call();
    expect(mocks.rateLimit).toHaveBeenCalledWith('agent-claim-init:agent:agent-1', expect.objectContaining({ maxAttempts: 10 }));
  });

  it('given the limit is hit, should 429 and mint nothing', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfter: 60 });
    const response = await call();
    expect(response.status).toBe(429);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('given the agent already has an owner, should 409 already_claimed', async () => {
    mocks.start.mockResolvedValue({ ok: false, error: 'already_claimed' });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'already_claimed' });
  });

  it('given a revoked agent or a spent claim token, should 404', async () => {
    mocks.start.mockResolvedValue({ ok: false, error: 'not_claimable' });
    expect((await call()).status).toBe(404);
  });

  it('given a store failure, should 503', async () => {
    mocks.start.mockRejectedValue(new mocks.StoreError('start_session_claim', { errorName: 'x', code: null, constraint: null }));
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});
